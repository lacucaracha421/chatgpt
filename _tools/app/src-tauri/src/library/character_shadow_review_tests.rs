    use super::super::characters::{tests::Fixture, DecisionKind, DecisionRequest, Target};
    use super::*;

    mod performance_measurement {
        use super::*;
        use rusqlite::ffi;
        use std::{
            cell::{Cell, RefCell},
            ffi::{c_char, c_int, c_uint, c_void, CStr},
            sync::Once,
            time::Instant,
        };

        static INSTALL: Once = Once::new();
        thread_local! {
            static ENABLED: Cell<bool> = const { Cell::new(false) };
            static STATEMENTS: Cell<u64> = const { Cell::new(0) };
            static SQL: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
            static PROFILE_NANOS: RefCell<BTreeMap<&'static str, u64>> = const { RefCell::new(BTreeMap::new()) };
            static PROFILE_SQL: RefCell<BTreeMap<String, (u64, u64)>> = const { RefCell::new(BTreeMap::new()) };
        }

        unsafe extern "C" fn trace(
            kind: c_uint,
            _context: *mut c_void,
            statement: *mut c_void,
            detail: *mut c_void,
        ) -> c_int {
            if ENABLED.with(Cell::get) {
                if kind == ffi::SQLITE_TRACE_STMT {
                    STATEMENTS.with(|count| count.set(count.get() + 1));
                    let expanded = detail.cast::<c_char>();
                    let raw = if expanded.is_null() {
                        ffi::sqlite3_sql(statement.cast())
                    } else {
                        expanded
                    };
                    if !raw.is_null() {
                        let sql = CStr::from_ptr(raw).to_string_lossy().into_owned();
                        SQL.with(|statements| statements.borrow_mut().push(sql));
                    }
                } else if kind == ffi::SQLITE_TRACE_PROFILE {
                    let raw = ffi::sqlite3_sql(statement.cast());
                    if !raw.is_null() && !detail.is_null() {
                        let sql = CStr::from_ptr(raw).to_string_lossy();
                        let nanos = (*(detail.cast::<i64>())).max(0) as u64;
                        PROFILE_NANOS.with(|profile| {
                            *profile.borrow_mut().entry(category(&sql)).or_default() += nanos;
                        });
                        PROFILE_SQL.with(|profile| {
                            let key = sql.split_whitespace().collect::<Vec<_>>().join(" ");
                            let mut profile = profile.borrow_mut();
                            let entry = profile
                                .entry(key.chars().take(110).collect())
                                .or_default();
                            *entry = (entry.0 + 1, entry.1 + nanos);
                        });
                    }
                }
            }
            0
        }

        unsafe extern "C" fn on_connection_open(
            database: *mut ffi::sqlite3,
            _error: *mut *mut c_char,
            _api: *const ffi::sqlite3_api_routines,
        ) -> c_int {
            ffi::sqlite3_trace_v2(
                database,
                ffi::SQLITE_TRACE_STMT | ffi::SQLITE_TRACE_PROFILE,
                Some(trace),
                std::ptr::null_mut(),
            )
        }

        fn install_trace() {
            INSTALL.call_once(|| {
                let result = unsafe { ffi::sqlite3_auto_extension(Some(on_connection_open)) };
                assert_eq!(result, ffi::SQLITE_OK);
            });
        }

        fn copy_snapshot() -> (tempfile::TempDir, Library) {
            let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/perf-root");
            assert!(source.join("library.sqlite").is_file());
            assert!(source.join(".cache/characters/s36_shadow.sqlite").is_file());
            let temp = tempfile::tempdir().unwrap();
            std::fs::copy(
                source.join("library.sqlite"),
                temp.path().join("library.sqlite"),
            )
            .unwrap();
            let cache = temp.path().join(".cache/characters");
            std::fs::create_dir_all(&cache).unwrap();
            std::fs::copy(
                source.join(".cache/characters/s36_shadow.sqlite"),
                cache.join("s36_shadow.sqlite"),
            )
            .unwrap();
            let library = Library::open(temp.path()).unwrap();
            (temp, library)
        }

        fn category(sql: &str) -> &'static str {
            if sql.contains("FROM scores") || sql.contains("sqlite_master") {
                "shadow cache"
            } else if sql.contains("FROM asset_classifications WHERE asset_id") {
                "broad-folder per asset"
            } else if sql.contains("origin<>'manual'") {
                "native decision per pair"
            } else if sql.contains("origin='manual'") {
                "manual decision per pair"
            } else if sql.contains("WHERE id IN (SELECT value FROM json_each") {
                "candidate assets batch"
            } else if sql.contains("WITH RECURSIVE scope") {
                "target reference eligibility"
            } else if sql.contains("FROM assets") {
                "other asset read"
            } else if sql.contains("FROM character_targets")
                || sql.contains("FROM character_references")
            {
                "target details"
            } else {
                "other"
            }
        }

        fn statement_count<T>(call: impl FnOnce() -> T) -> (T, u64) {
            STATEMENTS.with(|count| count.set(0));
            SQL.with(|statements| statements.borrow_mut().clear());
            PROFILE_NANOS.with(|profile| profile.borrow_mut().clear());
            PROFILE_SQL.with(|profile| profile.borrow_mut().clear());
            ENABLED.with(|enabled| enabled.set(true));
            let value = call();
            ENABLED.with(|enabled| enabled.set(false));
            (value, STATEMENTS.with(Cell::get))
        }

        fn fixture_with_rows(count: usize) -> Fixture {
            let fixture = Fixture::new();
            let target = fixture.ready("Statement gate");
            let mut rows = Vec::with_capacity(count);
            for index in 0..count {
                let id = format!("statement-{index:04}");
                series_asset(&fixture, &id);
                rows.push((
                    id,
                    target.id.clone(),
                    if index % 2 == 0 {
                        "automatic"
                    } else {
                        "recommended"
                    },
                ));
            }
            for chunk in rows.chunks(100) {
                let borrowed = chunk
                    .iter()
                    .map(|(asset, target, verdict)| {
                        (
                            asset.as_str(),
                            target.as_str(),
                            *verdict,
                            0.1,
                            "statement-v1",
                            "none",
                            "2026-09-29T00:00:00Z",
                        )
                    })
                    .collect::<Vec<_>>();
                insert(fixture.temp.path(), &borrowed);
            }
            fixture
        }

        #[test]
        fn shadow_review_page_checks_reference_files_without_the_database_lock() {
            let fixture = fixture_with_rows(10);
            let checks = &crate::library::character_sources::REFERENCE_CHECKS;
            checks.with(|count| count.set((0, 0, 0)));
            let page = fixture
                .library
                .character_shadow_review_page(ShadowReviewQuery {
                    offset: 0,
                    limit: 200,
                    mode: None,
                    series_id: None,
                })
                .unwrap();
            assert_eq!(
                page.summary.automatic.pending + page.summary.recommended.pending,
                10
            );
            let (all, locked, _) = checks.with(|count| count.get());
            assert!(all > 0);
            assert_eq!(locked, 0);
        }

        /// The row-dependent reads run in batches of `READ_BATCH_ROWS`, one library borrow each.
        /// A list that spans several batches must give what one big read would: every pair
        /// counted once, decisions found in any batch.
        #[test]
        fn review_list_spanning_several_read_batches_counts_every_pair() {
            let fixture = Fixture::new();
            let target = fixture.ready("Batched");
            let total = READ_BATCH_ROWS + 50;
            {
                let c = fixture.library.connection().unwrap();
                let tx = c.unchecked_transaction().unwrap();
                for index in 0..total {
                    let id = format!("batched-{index:05}");
                    tx.execute(
                        "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
                         VALUES(?1,?2,'image',?1,'assets/'||?1||'.png','thumbnails/'||?1||'.webp',7,3,2,'2026-09-08','normal')",
                        params![id, content_hash(&id)],
                    )
                    .unwrap();
                    tx.execute(
                        "INSERT INTO asset_classifications VALUES(?1,?2)",
                        params![id, fixture.series],
                    )
                    .unwrap();
                }
                tx.commit().unwrap();
            }
            super::super::super::character_shadow::Cache::open(fixture.temp.path()).unwrap();
            {
                let cache = Connection::open(
                    fixture.temp.path().join(".cache/characters/s36_shadow.sqlite"),
                )
                .unwrap();
                let tx = cache.unchecked_transaction().unwrap();
                for index in 0..total {
                    let id = format!("batched-{index:05}");
                    tx.execute(
                        "INSERT INTO scores(asset_id,content_hash,target_id,knn3,verdict,policy_version,feature_id,native_outcome,native_at,scored_at,prior_manual_rejections)
                         VALUES(?1,?2,?3,0.1,'recommended','batched-v1','feature','none','2026-09-29T00:00:00Z','2026-09-29T00:00:00Z',100)",
                        params![id, content_hash(&id), target.id],
                    )
                    .unwrap();
                }
                tx.commit().unwrap();
            }
            // One manual rejection in the first batch and one in the last.
            for index in [0, total - 1] {
                fixture
                    .library
                    .connection()
                    .unwrap()
                    .execute(
                        "INSERT INTO character_decisions(target_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
                         VALUES(?1,?2,'hash','rejected','fingerprint','{}','manual','2026-10-01T00:00:00Z')",
                        params![target.id, format!("batched-{index:05}")],
                    )
                    .unwrap();
            }
            let page = fixture
                .library
                .character_shadow_review_page(ShadowReviewQuery {
                    offset: 0,
                    limit: 10,
                    mode: None,
                    series_id: None,
                })
                .unwrap();
            assert_eq!(page.summary.recommended.pending as usize, total - 2);
            assert_eq!(page.summary.recommended.rejected, 2);
            let summary = fixture.library.character_shadow_review_summary().unwrap();
            assert_eq!(summary.recommended as usize, total - 2);
        }

        #[test]
        fn shadow_review_page_statement_count_is_independent_of_row_count() {
            // The per-character judgment reads (newest policy, examples, decisions, tagger readings) are
            // a fixed handful for one character, whatever the number of rows.
            // The page reads the library in short borrows (not one long hold); each borrow's
            // opening statements count here, so 37 measured on 2026-10-18 (was within 28 on one hold).
            const MAX_PAGE_STATEMENTS: u64 = 38;
            const MAX_SUMMARY_STATEMENTS: u64 = 14;
            install_trace();
            let small = fixture_with_rows(5);
            let large = fixture_with_rows(250);
            let query = || ShadowReviewQuery {
                offset: 0,
                limit: 200,
                mode: None,
                series_id: None,
            };
            let (_, small_count) =
                statement_count(|| small.library.character_shadow_review_page(query()).unwrap());
            let (page, large_count) =
                statement_count(|| large.library.character_shadow_review_page(query()).unwrap());
            eprintln!("statement gate: small={small_count} large={large_count}");
            assert_eq!(page.summary.automatic.pending, 125);
            assert_eq!(page.summary.recommended.pending, 125);
            assert_eq!(small_count, large_count);
            assert!(
                large_count <= MAX_PAGE_STATEMENTS,
                "{large_count} statements exceed the {MAX_PAGE_STATEMENTS} statement gate"
            );

            let (_, small_summary_count) =
                statement_count(|| small.library.character_shadow_review_summary().unwrap());
            let (summary, large_summary_count) =
                statement_count(|| large.library.character_shadow_review_summary().unwrap());
            eprintln!(
                "summary statement gate: small={small_summary_count} large={large_summary_count}"
            );
            assert_eq!(summary.automatic, 125);
            assert_eq!(summary.recommended, 125);
            assert_eq!(small_summary_count, large_summary_count);
            assert!(
                large_summary_count <= MAX_SUMMARY_STATEMENTS,
                "{large_summary_count} summary statements exceed the {MAX_SUMMARY_STATEMENTS} statement gate"
            );
        }

        #[test]
        #[ignore = "reads target/perf-root snapshot"]
        fn measure_home_shadow_review_page() {
            install_trace();
            let (_temp, library) = copy_snapshot();
            let mut elapsed = Vec::new();
            for run in 1..=3 {
                let started = Instant::now();
                let (page, statements) = statement_count(|| {
                    library
                        .character_shadow_review_page(ShadowReviewQuery {
                            offset: 0,
                            limit: 200,
                            mode: None,
                            series_id: None,
                        })
                        .unwrap()
                });
                let millis = started.elapsed().as_secs_f64() * 1000.0;
                elapsed.push(millis);
                let mut categories = BTreeMap::<&str, usize>::new();
                SQL.with(|statements| {
                    for sql in statements.borrow().iter() {
                        *categories.entry(category(sql)).or_default() += 1;
                    }
                });
                let profile = PROFILE_NANOS.with(|profile| {
                    profile
                        .borrow()
                        .iter()
                        .map(|(category, nanos)| (*category, *nanos as f64 / 1_000_000.0))
                        .collect::<BTreeMap<_, _>>()
                });
                eprintln!(
                    "run={run} ms={millis:.2} statements={statements} items={} pending={} categories={categories:?} sql_ms={profile:?}",
                    page.items.len(),
                    page.summary.automatic.pending + page.summary.recommended.pending
                );
            }
            elapsed.sort_by(f64::total_cmp);
            eprintln!("median_ms={:.2}", elapsed[1]);

            let mut summary_elapsed = Vec::new();
            for run in 1..=3 {
                let started = Instant::now();
                let (summary, statements) =
                    statement_count(|| library.character_shadow_review_summary().unwrap());
                let millis = started.elapsed().as_secs_f64() * 1000.0;
                summary_elapsed.push(millis);
                let profile = PROFILE_NANOS.with(|profile| {
                    profile
                        .borrow()
                        .iter()
                        .map(|(category, nanos)| (*category, *nanos as f64 / 1_000_000.0))
                        .collect::<BTreeMap<_, _>>()
                });
                eprintln!(
                    "summary_run={run} ms={millis:.2} statements={statements} pending={} targets={} sql_ms={profile:?}",
                    summary.automatic + summary.recommended,
                    summary.targets.len()
                );
            }
            summary_elapsed.sort_by(f64::total_cmp);
            eprintln!("summary_median_ms={:.2}", summary_elapsed[1]);
        }

        /// Cost of the Home 확인 count on the target/perf-root snapshot (opened in place; it is a
        /// disposable copy, never the production library).
        #[test]
        #[ignore = "reads target/perf-root snapshot"]
        fn measure_confirm_counts() {
            install_trace();
            let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/perf-root");
            assert!(root.join("library.sqlite").is_file());
            let library = Library::open(&root).unwrap();
            for run in 1..=3 {
                if run > 1 {
                    // A new list key each run: the totals cache would otherwise answer.
                    library.character_changes.changed_table("character_decisions");
                }
                let started = Instant::now();
                let ((counts, hold_total, hold_max), statements) = statement_count(|| {
                    let (result, total, longest) =
                        Library::measure_character_summary_hold(|| {
                            library.character_confirm_counts(None)
                        });
                    (result.unwrap(), total, longest)
                });
                let millis = started.elapsed().as_secs_f64() * 1000.0;
                let mut top = PROFILE_SQL.with(|p| {
                    p.borrow()
                        .iter()
                        .map(|(sql, (n, nanos))| (*nanos as f64 / 1e6, *n, sql.clone()))
                        .collect::<Vec<_>>()
                });
                top.sort_by(|a, b| b.0.total_cmp(&a.0));
                eprintln!(
                    "confirm_counts run={run} wall_ms={millis:.1} hold_total_ms={hold_total:.1} hold_max_ms={hold_max:.1} statements={statements} counts={counts:?}"
                );
                for (ms, n, sql) in top.iter().take(8) {
                    eprintln!("   {ms:8.1} ms x{n}  {sql}");
                }
            }
        }
    }

    fn insert(root: &Path, rows: &[(&str, &str, &str, f64, &str, &str, &str)]) {
        super::super::character_shadow::Cache::open(root).unwrap();
        let c = Connection::open(root.join(".cache/characters/s36_shadow.sqlite")).unwrap();
        for (asset, target, verdict, knn3, version, outcome, scored_at) in rows {
            c.execute(
                "INSERT OR REPLACE INTO scores(asset_id,content_hash,target_id,knn3,verdict,policy_version,feature_id,native_outcome,native_at,scored_at,prior_manual_rejections)
                 VALUES(?1,?2,?3,?4,?5,?6,'feature',?7,?8,?8,100)",
                params![asset, content_hash(asset), target, knn3, verdict, version, outcome, scored_at],
            )
            .unwrap();
        }
    }

    fn content_hash(asset: &str) -> String {
        use sha2::Digest;
        sha2::Sha256::digest(asset.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// One more series-level image so two pending pairs can be judged manually.
    fn series_asset(f: &Fixture, id: &str) {
        let original = format!("assets/{id}.png");
        let thumbnail = format!("thumbnails/{id}.webp");
        std::fs::write(f.temp.path().join(&original), id.as_bytes()).unwrap();
        std::fs::write(f.temp.path().join(&thumbnail), id.as_bytes()).unwrap();
        let c = f.library.connection().unwrap();
        c.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
            VALUES(?1,?2,'image',?1,?3,?4,7,3,2,'2026-09-08','normal')", params![id, content_hash(id), original, thumbnail]).unwrap();
        c.execute(
            "INSERT INTO asset_classifications VALUES(?1,?2)",
            params![id, f.series],
        )
        .unwrap();
    }

    fn decide(f: &Fixture, target: &Target, asset: &str, decision: DecisionKind) {
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: vec![asset.into()],
                decision,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
    }

    fn page(f: &Fixture, offset: u32, limit: u32) -> ShadowReviewPage {
        f.library
            .character_shadow_review_page(ShadowReviewQuery {
                offset,
                limit,
                mode: None,
                series_id: None,
            })
            .unwrap()
    }

    /// The cached list of one mode and series scope.
    fn items_in(
        library: &Library,
        mode: Option<&str>,
        series_id: Option<&str>,
    ) -> ShadowReviewItems {
        let doubtful = shadow_review_mode(mode).unwrap();
        (*library.shadow_review_list(doubtful, series_id).unwrap()).clone()
    }

    /// Pre-batching implementation retained only as an executable compatibility oracle.
    fn legacy_items(
        library: &Library,
        mode: Option<&str>,
        series_id: Option<&str>,
    ) -> ShadowReviewItems {
        let doubtful = shadow_review_mode(mode).unwrap();
        let mut page = ShadowReviewItems {
            items: Vec::new(),
            policy_version: None,
            summary: ShadowReviewSummary::default(),
        };
        let Some((version, mut rows)) = shadow_rows(&library.root, doubtful).unwrap() else {
            return page;
        };
        page.policy_version = Some(version);
        let connection = library.connection().unwrap();
        if let Some(series_id) = series_id {
            let in_series = connection
                .prepare("SELECT id FROM character_targets WHERE series_classification_id=?1")
                .unwrap()
                .query_map([series_id], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<BTreeSet<_>>>()
                .unwrap();
            rows.retain(|row| in_series.contains(&row.target_id));
        }
        if !super::super::character_scope::broad_folder_scope_enabled(&connection).unwrap() {
            let covered =
                super::super::character_scope::series_covered_folders(&connection).unwrap();
            let mut folders = connection
                .prepare("SELECT classification_id FROM asset_classifications WHERE asset_id=?1")
                .unwrap();
            let mut inside = BTreeMap::new();
            rows.retain(|row| {
                *inside.entry(row.asset_id.clone()).or_insert_with(|| {
                    folders
                        .query_map([&row.asset_id], |result| result.get::<_, String>(0))
                        .unwrap()
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .unwrap()
                        .iter()
                        .any(|id| covered.contains(id))
                })
            });
        }
        let rows = {
            let mut native = connection
                .prepare(
                    "SELECT decision FROM character_decisions
                     WHERE target_id=?1 AND source_asset_id=?2 AND origin<>'manual'
                     ORDER BY sequence DESC LIMIT 1",
                )
                .unwrap();
            let mut keyed = Vec::with_capacity(rows.len());
            for (index, mut row) in rows.into_iter().enumerate() {
                let classified = native
                    .query_row(params![row.target_id, row.asset_id], |result| {
                        result.get::<_, String>(0)
                    })
                    .optional()
                    .unwrap()
                    .as_deref()
                    == Some("accepted");
                if classified && row.native_outcome == "none" {
                    row.native_outcome = "accepted_automatic".into();
                }
                if doubtful && !classified {
                    continue;
                }
                keyed.push(((row.verdict != "automatic", classified, index), row));
            }
            keyed.sort_by_key(|(key, _)| *key);
            keyed.into_iter().map(|(_, row)| row).collect::<Vec<_>>()
        };
        let mut targets: BTreeMap<String, Option<TargetInfo>> = BTreeMap::new();
        let mut asset = connection
            .prepare(
                "SELECT original_name,width,height FROM assets
                 WHERE id=?1 AND content_hash=?2 AND status='normal' AND media_kind='image'",
            )
            .unwrap();
        let mut decision = connection
            .prepare(
                "SELECT decision,created_at FROM character_decisions
                 WHERE target_id=?1 AND source_asset_id=?2 AND origin='manual'
                 ORDER BY sequence DESC LIMIT 1",
            )
            .unwrap();
        for row in rows {
            let origin_tiers = page.summary.by_origin.get_mut(&row.origin).unwrap();
            let origin_counts = if row.verdict == "automatic" {
                &mut origin_tiers.automatic
            } else {
                &mut origin_tiers.recommended
            };
            let counts = match row.verdict.as_str() {
                _ if doubtful => &mut page.summary.doubtful,
                "automatic" => &mut page.summary.automatic,
                _ => &mut page.summary.recommended,
            };
            let manual: Option<(String, String)> = decision
                .query_row(params![row.target_id, row.asset_id], |result| {
                    Ok((result.get(0)?, result.get(1)?))
                })
                .optional()
                .unwrap();
            match manual
                .as_ref()
                .map(|(value, at)| (value.as_str(), at.as_str()))
            {
                Some(("cleared", _)) | None => {}
                Some((value, at)) => {
                    if at > row.scored_at.as_str() {
                        if value == "accepted" {
                            counts.accepted += 1;
                            if !doubtful {
                                origin_counts.accepted += 1;
                            }
                        } else {
                            counts.rejected += 1;
                            if !doubtful {
                                origin_counts.rejected += 1;
                            }
                        }
                    }
                    continue;
                }
            }
            let stored: Option<(String, i64, i64)> = asset
                .query_row(params![row.asset_id, row.content_hash], |result| {
                    Ok((result.get(0)?, result.get(1)?, result.get(2)?))
                })
                .optional()
                .unwrap();
            let Some((original_name, width, height)) = stored else {
                continue;
            };
            let target = match targets.entry(row.target_id.clone()) {
                std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::btree_map::Entry::Vacant(entry) => {
                    let info = match library.read_character_target(&connection, &row.target_id) {
                        Ok(target) => Some(TargetInfo {
                            name: target.display_name.clone(),
                            enabled: target.enabled,
                            fingerprint: target.fingerprint.clone(),
                            reference_asset_ids: target
                                .usable_references()
                                .filter_map(|reference| reference.asset_id.clone())
                                .collect(),
                        }),
                        Err(Error::NotFound) => None,
                        Err(error) => panic!("legacy target read failed: {error}"),
                    };
                    entry.insert(info)
                }
            };
            let Some(target) = target.as_ref().filter(|target| target.enabled) else {
                continue;
            };
            counts.pending += 1;
            if !doubtful {
                origin_counts.pending += 1;
            }
            page.items.push(ShadowReviewItem {
                asset_id: row.asset_id,
                content_hash: row.content_hash,
                original_name,
                width: u32::try_from(width).unwrap_or(0),
                height: u32::try_from(height).unwrap_or(0),
                target_id: row.target_id,
                target_name: target.name.clone(),
                target_fingerprint: target.fingerprint.clone(),
                reference_asset_ids: target.reference_asset_ids.iter().take(4).cloned().collect(),
                verdict: row.verdict,
                origin: row.origin,
                knn3: row.knn3,
                native_outcome: row.native_outcome,
                scored_at: row.scored_at,
                // Every fixture character here is far from switching.
                folded: !doubtful,
            });
        }
        page
    }

    #[test]
    fn batched_shadow_review_matches_legacy_for_mixed_scopes_and_decisions() {
        let fixture = Fixture::new();
        let here = fixture.ready("Here");
        let there = fixture.ready_in_series("There", &fixture.child);
        let disabled = fixture.ready("Disabled");
        fixture
            .library
            .save_character_target(super::super::characters::TargetDraft {
                id: Some(disabled.id.clone()),
                expected_revision: Some(disabled.revision),
                series_classification_id: disabled.series_classification_id.clone(),
                linked_classification_id: disabled.linked_classification_id.clone(),
                display_name: disabled.display_name.clone(),
                description: String::new(),
                thumbnail_asset_id: None,
                enabled: false,
            })
            .unwrap();
        for id in ["mixed-a", "mixed-b", "mixed-c", "mixed-d", "mixed-broad"] {
            series_asset(&fixture, id);
        }
        fixture
            .library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=(SELECT parent_id FROM classification_entries WHERE id=?1)
                 WHERE asset_id='mixed-broad'",
                [&fixture.series],
            )
            .unwrap();
        fixture
            .library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='mixed-c'",
                [&fixture.child],
            )
            .unwrap();
        let scored_at = "2020-01-01T00:00:00Z";
        insert(
            fixture.temp.path(),
            &[
                (
                    "mixed-a",
                    &here.id,
                    "automatic",
                    0.1,
                    "mixed-v1",
                    "none",
                    scored_at,
                ),
                (
                    "mixed-b",
                    &here.id,
                    "recommended",
                    0.2,
                    "mixed-v1",
                    "none",
                    scored_at,
                ),
                (
                    "mixed-c",
                    &there.id,
                    "automatic",
                    0.1,
                    "mixed-v1",
                    "none",
                    scored_at,
                ),
                (
                    "mixed-d", &here.id, "none", 0.3, "mixed-v1", "none", scored_at,
                ),
                (
                    "mixed-broad",
                    &here.id,
                    "recommended",
                    0.2,
                    "mixed-v1",
                    "none",
                    scored_at,
                ),
                (
                    "asset-5",
                    &disabled.id,
                    "automatic",
                    0.1,
                    "mixed-v1",
                    "none",
                    scored_at,
                ),
            ],
        );
        let connection = fixture.library.connection().unwrap();
        for (asset_id, target_id) in [("mixed-a", &here.id), ("mixed-d", &here.id)] {
            connection
                .execute(
                    "INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
                     VALUES(?1,?2,?2,?3,'accepted','native','{}','automatic','2019-01-01T00:00:00Z')",
                    params![target_id, asset_id, content_hash(asset_id)],
                )
                .unwrap();
        }
        drop(connection);
        decide(&fixture, &here, "mixed-b", DecisionKind::Rejected);
        decide(&fixture, &there, "mixed-c", DecisionKind::Accepted);

        let assert_summary_matches = || {
            let expected = legacy_items(&fixture.library, None, None);
            let actual = fixture.library.character_shadow_review_summary().unwrap();
            assert_eq!(actual.automatic, expected.summary.automatic.pending);
            assert_eq!(actual.recommended, expected.summary.recommended.pending);
            let expected_targets = expected.items.iter().fold(
                BTreeMap::<String, (String, u32, u32)>::new(),
                |mut targets, item| {
                    let tally = targets.entry(item.target_id.clone()).or_insert((
                        item.target_name.clone(),
                        0,
                        0,
                    ));
                    if item.verdict == "automatic" {
                        tally.1 += 1;
                    } else {
                        tally.2 += 1;
                    }
                    targets
                },
            );
            assert_eq!(
                actual
                    .targets
                    .into_iter()
                    .map(|target| {
                        (
                            target.target_id,
                            (target.target_name, target.automatic, target.recommended),
                        )
                    })
                    .collect::<BTreeMap<_, _>>(),
                expected_targets
            );
        };
        assert_summary_matches();

        for (mode, series) in [
            (None, None),
            (None, Some(fixture.series.as_str())),
            (None, Some(fixture.child.as_str())),
            (Some("doubtful"), None),
            (Some("doubtful"), Some(fixture.series.as_str())),
        ] {
            assert_eq!(
                items_in(&fixture.library, mode, series),
                legacy_items(&fixture.library, mode, series),
                "mode={mode:?} series={series:?}"
            );
        }
        fixture
            .library
            .set_character_broad_folder_scope(true)
            .unwrap();
        assert_summary_matches();
        assert_eq!(
            items_in(&fixture.library, None, None),
            legacy_items(&fixture.library, None, None)
        );
    }

    #[test]
    fn character_shadow_review_hides_broad_folder_scores_while_the_rule_is_off() {
        let f = Fixture::new();
        let target = f.ready("Shadow");
        series_asset(&f, "inside");
        series_asset(&f, "broad");
        // "broad" is filed directly in the series' parent folder (no registered series above).
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=(SELECT parent_id FROM classification_entries WHERE id=?1)
                 WHERE asset_id='broad'",
                [&f.series],
            )
            .unwrap();
        let rows: Vec<_> = ["inside", "broad"]
            .iter()
            .map(|id| {
                (
                    *id,
                    target.id.as_str(),
                    "recommended",
                    0.2,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                )
            })
            .collect();
        insert(f.temp.path(), &rows);
        let ids = |f: &Fixture| {
            let mut ids: Vec<_> = page(f, 0, 50)
                .items
                .into_iter()
                .map(|i| i.asset_id)
                .collect();
            ids.sort();
            ids
        };
        assert_eq!(ids(&f), vec!["inside"]);
        assert_eq!(page(&f, 0, 50).summary.recommended.pending, 1);
        f.library.set_character_broad_folder_scope(true).unwrap();
        assert_eq!(ids(&f), vec!["broad", "inside"]);
        f.library.set_character_broad_folder_scope(false).unwrap();
        assert_eq!(ids(&f), vec!["inside"]);
    }

    #[test]
    fn character_shadow_review_missing_cache_is_empty() {
        let f = Fixture::new();
        let page = page(&f, 0, 50);
        assert!(page.items.is_empty());
        assert_eq!(page.policy_version, None);
        assert_eq!(page.summary, ShadowReviewSummary::default());
        assert!(!f
            .temp
            .path()
            .join(".cache/characters/s36_shadow.sqlite")
            .exists());
        assert!(f
            .library
            .character_shadow_review_page(ShadowReviewQuery {
                offset: 0,
                limit: 0,
                mode: None,
                series_id: None,
            })
            .is_err());
    }

    #[test]
    fn character_shadow_review_puts_already_classified_pairs_after_new_findings() {
        let f = Fixture::new();
        let target = f.ready("Shadow");
        let root = f.temp.path();
        for id in ["new-1", "new-2", "done-1", "done-2"] {
            series_asset(&f, id);
        }
        let rows: Vec<_> = ["done-1", "new-1", "done-2", "new-2"]
            .iter()
            .map(|id| {
                (
                    *id,
                    target.id.as_str(),
                    "automatic",
                    0.12,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                )
            })
            .collect();
        insert(root, &rows);
        let c = f.library.connection().unwrap();
        for id in ["done-1", "done-2"] {
            c.execute(
                "INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
                 VALUES(?1,?2,?2,?3,'accepted',?4,'{}','automatic','2026-09-20T00:00:00Z')",
                params![target.id, id, content_hash(id), target.fingerprint],
            )
            .unwrap();
        }
        drop(c);
        let items = page(&f, 0, 50).items;
        let order: Vec<_> = items.iter().map(|i| i.asset_id.as_str()).collect();
        assert_eq!(order.len(), 4);
        assert!(
            order[..2].iter().all(|id| id.starts_with("new-")),
            "{order:?}"
        );
        assert!(
            order[2..].iter().all(|id| id.starts_with("done-")),
            "{order:?}"
        );
        assert!(items[..2].iter().all(|i| i.native_outcome == "none"));
        assert!(items[2..]
            .iter()
            .all(|i| i.native_outcome == "accepted_automatic"));
        // Pagination follows the same order.
        assert_eq!(page(&f, 2, 1).items[0].asset_id, order[2]);
    }

    #[test]
    fn character_shadow_review_filters_orders_and_counts() {
        let f = Fixture::new();
        let target = f.ready("Shadow");
        let other = f.ready("Other");
        let disabled = f.ready("Disabled");
        f.library
            .save_character_target(super::super::characters::TargetDraft {
                id: Some(disabled.id.clone()),
                expected_revision: Some(disabled.revision),
                series_classification_id: disabled.series_classification_id.clone(),
                linked_classification_id: disabled.linked_classification_id.clone(),
                display_name: disabled.display_name.clone(),
                description: String::new(),
                thumbnail_asset_id: None,
                enabled: false,
            })
            .unwrap();
        let root = f.temp.path();
        series_asset(&f, "asset-8");
        insert(
            root,
            &[
                (
                    "asset-5",
                    &target.id,
                    "recommended",
                    0.14,
                    "v1",
                    "recommended",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-8",
                    &target.id,
                    "automatic",
                    0.12,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-5",
                    &other.id,
                    "automatic",
                    0.10,
                    "v1",
                    "accepted_automatic",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-6",
                    &other.id,
                    "none",
                    0.30,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-5",
                    &disabled.id,
                    "automatic",
                    0.05,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-6",
                    "missing-target",
                    "automatic",
                    0.05,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-7",
                    &target.id,
                    "automatic",
                    0.05,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-0",
                    &target.id,
                    "automatic",
                    0.01,
                    "v0",
                    "none",
                    "2026-09-22T00:00:00Z",
                ),
            ],
        );
        // asset-7 does not exist; the other target's asset-5 row gets a stale hash.
        let c = Connection::open(root.join(".cache/characters/s36_shadow.sqlite")).unwrap();
        c.execute(
            "UPDATE scores SET content_hash='f' WHERE asset_id='asset-5' AND target_id=?1",
            [&other.id],
        )
        .unwrap();
        drop(c);

        let first = page(&f, 0, 50);
        assert_eq!(first.policy_version.as_deref(), Some("v1"));
        let pairs: Vec<(&str, &str, &str)> = first
            .items
            .iter()
            .map(|i| {
                (
                    i.asset_id.as_str(),
                    i.target_id.as_str(),
                    i.verdict.as_str(),
                )
            })
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("asset-8", target.id.as_str(), "automatic"),
                ("asset-5", target.id.as_str(), "recommended"),
            ]
        );
        assert_eq!(first.items[0].target_name, "Shadow");
        assert_eq!(first.items[0].target_fingerprint, target.fingerprint);
        assert_eq!(first.items[0].reference_asset_ids.len(), 4);
        assert_eq!(first.items[0].knn3, Some(0.12));
        assert_eq!(first.items[0].native_outcome, "none");
        assert_eq!(first.items[0].original_name, "asset-8");
        assert_eq!((first.items[0].width, first.items[0].height), (3, 2));
        assert_eq!(first.next_offset, None);
        assert_eq!(
            first.summary.automatic,
            VerdictCounts {
                pending: 1,
                accepted: 0,
                rejected: 0
            }
        );
        assert_eq!(
            first.summary.recommended,
            VerdictCounts {
                pending: 1,
                accepted: 0,
                rejected: 0
            }
        );

        // Pagination by offset over the pending list.
        let second = page(&f, 0, 1);
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].asset_id, "asset-8");
        assert_eq!(second.next_offset, Some(1));
        assert_eq!(second.summary.automatic.pending, 1);
        let third = page(&f, 1, 1);
        assert_eq!(third.items[0].asset_id, "asset-5");
        assert_eq!(third.next_offset, None);

        // A manual decision after scoring removes the pair and counts as reviewed.
        decide(&f, &target, "asset-8", DecisionKind::Accepted);
        decide(&f, &target, "asset-5", DecisionKind::Rejected);
        let reviewed = page(&f, 0, 50);
        assert!(reviewed.items.is_empty());
        assert_eq!(
            reviewed.summary.automatic,
            VerdictCounts {
                pending: 0,
                accepted: 1,
                rejected: 0
            }
        );
        assert_eq!(
            reviewed.summary.recommended,
            VerdictCounts {
                pending: 0,
                accepted: 0,
                rejected: 1
            }
        );

        // Clearing the decision returns the pair to the queue.
        decide(&f, &target, "asset-5", DecisionKind::Cleared);
        let cleared = page(&f, 0, 50);
        assert_eq!(cleared.items.len(), 1);
        assert_eq!(cleared.items[0].asset_id, "asset-5");
        assert_eq!(
            cleared.summary.recommended,
            VerdictCounts {
                pending: 1,
                accepted: 0,
                rejected: 0
            }
        );

        // A decision made before the shadow row was scored neither pends nor counts.
        let c = Connection::open(root.join(".cache/characters/s36_shadow.sqlite")).unwrap();
        c.execute(
            "UPDATE scores SET scored_at='2099-01-01T00:00:00Z' WHERE asset_id='asset-8' AND target_id=?1",
            [&target.id],
        )
        .unwrap();
        drop(c);
        let earlier = page(&f, 0, 50);
        assert_eq!(earlier.summary.automatic, VerdictCounts::default());
    }
    #[test]
    fn confirm_counts_count_each_pair_once_under_its_highest_kind() {
        let f = Fixture::new();
        let target = f.ready("Count");
        {
            let c = f.library.connection().unwrap();
            // Close enough to switching that its 인식 추천 are not folded away.
            seed_readiness(
                f.temp.path(),
                &c,
                &target.id,
                "v1",
                "near",
                (0, 0, NEAR_EXAMPLES),
            );
        }
        for number in 8..14 {
            series_asset(&f, &format!("asset-{number}"));
        }
        let version = "v1";
        let scored = "2020-01-01T00:00:00Z";
        insert(
            f.temp.path(),
            &[
                (
                    "asset-8",
                    &target.id,
                    "automatic",
                    0.1,
                    version,
                    "none",
                    scored,
                ),
                (
                    "asset-9",
                    &target.id,
                    "recommended",
                    0.2,
                    version,
                    "none",
                    scored,
                ),
                (
                    "asset-12",
                    &target.id,
                    "automatic",
                    0.1,
                    version,
                    "none",
                    scored,
                ),
                (
                    "asset-13",
                    &target.id,
                    "none",
                    0.9,
                    version,
                    "accepted_automatic",
                    scored,
                ),
            ],
        );
        let c = f.library.connection().unwrap();
        // asset-13 was placed automatically, which the doubtful list reviews.
        c.execute(
            "INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
             VALUES(?1,'asset-13','asset-13',?2,'accepted',?3,'{}','automatic','now')",
            params![target.id, content_hash("asset-13"), target.fingerprint],
        )
        .unwrap();
        for (asset, reason) in [
            ("asset-8", "recommendation"),
            ("asset-10", "recommendation"),
            ("asset-11", "veto"),
            ("asset-12", "veto"),
        ] {
            c.execute(
                "INSERT INTO character_tagger_candidates(target_id,asset_id,asset_hash,reason,pixai_score,canary_score,created_at)
                 VALUES(?1,?2,?3,?4,0.9,0.9,'now')",
                params![target.id, asset, content_hash(asset), reason],
            )
            .unwrap();
        }
        drop(c);
        // asset-8: recognition and tags both read it; 9: recognition; 10: tags; 11 and 12: the tags
        // doubt a placement (12 is also a recognition candidate); 13: 학습 인식 doubts it.
        let expected = ConfirmCounts {
            recognition: 2,
            tag: 1,
            recheck: 3,
        };
        assert_eq!(f.library.character_confirm_counts(None).unwrap(), expected);
        assert_eq!(
            f.library.character_confirm_counts(Some(&f.series)).unwrap(),
            expected
        );
        assert_eq!(
            f.library
                .character_confirm_counts(Some("elsewhere"))
                .unwrap(),
            ConfirmCounts::default()
        );
        // The count follows the judgments: a manual decision removes the pair from every list.
        decide(&f, &target, "asset-8", DecisionKind::Accepted);
        decide(&f, &target, "asset-13", DecisionKind::Rejected);
        assert_eq!(
            f.library.character_confirm_counts(None).unwrap(),
            ConfirmCounts {
                recognition: 1,
                tag: 1,
                recheck: 2,
            }
        );
    }
    #[test]
    fn character_shadow_review_stable_shuffle_pages_and_origin_counts() {
        use sha2::{Digest, Sha256};
        let f = Fixture::new();
        let target = f.ready("Shuffle");
        for i in 8..20 {
            let id = format!("asset-{i}");
            series_asset(&f, &id);
            insert(
                f.temp.path(),
                &[(
                    &id,
                    &target.id,
                    if i < 17 { "automatic" } else { "recommended" },
                    i as f64 / 100.0,
                    "v1",
                    "none",
                    "2020-01-01T00:00:00Z",
                )],
            );
        }
        let cache =
            Connection::open(f.temp.path().join(".cache/characters/s36_shadow.sqlite")).unwrap();
        cache
            .execute(
                "UPDATE scores SET origin='backfill' WHERE asset_id IN ('asset-8','asset-18')",
                [],
            )
            .unwrap();
        let full = page(&f, 0, 50);
        let mut expected = (8..20).map(|i| format!("asset-{i}")).collect::<Vec<_>>();
        expected.sort_by_key(|id| {
            (
                id[6..].parse::<u32>().unwrap() >= 17,
                Sha256::digest(format!("v1|{id}|{}", target.id)).to_vec(),
            )
        });
        assert_eq!(
            full.items
                .iter()
                .map(|i| i.asset_id.clone())
                .collect::<Vec<_>>(),
            expected
        );
        let parts = (0..4)
            .flat_map(|i| page(&f, i * 3, 3).items.into_iter().map(|row| row.asset_id))
            .collect::<Vec<_>>();
        assert_eq!(parts, expected);
        // Scores changing within their tier cannot change the review order.
        cache.execute("UPDATE scores SET knn3=1-knn3", []).unwrap();
        assert_eq!(
            page(&f, 0, 50)
                .items
                .iter()
                .map(|i| i.asset_id.clone())
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(full.summary.by_origin["backfill"].automatic.pending, 1);
        assert_eq!(full.summary.by_origin["live"].automatic.pending, 8);
        decide(&f, &target, "asset-8", DecisionKind::Accepted);
        decide(&f, &target, "asset-18", DecisionKind::Rejected);
        let reviewed = page(&f, 0, 50);
        assert_eq!(reviewed.summary.by_origin["backfill"].automatic.accepted, 1);
        assert_eq!(
            reviewed.summary.by_origin["backfill"].recommended.rejected,
            1
        );
        assert_eq!(reviewed.summary.by_origin["live"].automatic.accepted, 0);
    }
    #[test]
    fn character_shadow_review_legacy_origin_is_live_without_migration() {
        let f = Fixture::new();
        let target = f.ready("Legacy");
        insert(
            f.temp.path(),
            &[(
                "asset-5",
                &target.id,
                "automatic",
                0.1,
                "v1",
                "none",
                "2020-01-01T00:00:00Z",
            )],
        );
        let cache =
            Connection::open(f.temp.path().join(".cache/characters/s36_shadow.sqlite")).unwrap();
        cache
            .execute_batch("ALTER TABLE scores DROP COLUMN origin; PRAGMA user_version=0;")
            .unwrap();
        let page = page(&f, 0, 50);
        assert_eq!(page.items[0].origin, "live");
        assert_eq!(page.summary.by_origin["live"].automatic.pending, 1);
        assert!(!super::super::character_shadow::cache_has_origin(&cache).unwrap());
    }
    #[test]
    fn character_shadow_review_series_scope_filters_items_and_counts() {
        let f = Fixture::new();
        let here = f.ready("Here");
        // `child` stands in for a second S36 series.
        let there = f.ready_in_series("There", &f.child);
        for id in ["asset-8", "asset-9", "asset-10"] {
            series_asset(&f, id);
        }
        let at = "2026-09-23T01:00:00Z";
        insert(
            f.temp.path(),
            &[
                ("asset-8", &here.id, "automatic", 0.1, "v1", "none", at),
                ("asset-9", &here.id, "recommended", 0.2, "v1", "none", at),
                ("asset-10", &there.id, "automatic", 0.1, "v1", "none", at),
                ("asset-1", &there.id, "automatic", 0.1, "v1", "none", at),
            ],
        );
        // asset-1 is inside the nested series, so it can be judged there.
        decide(&f, &there, "asset-1", DecisionKind::Rejected);
        let scoped = |series: Option<&str>, mode: Option<&str>| {
            f.library
                .character_shadow_review_page(ShadowReviewQuery {
                    offset: 0,
                    limit: 50,
                    mode: mode.map(Into::into),
                    series_id: series.map(Into::into),
                })
                .unwrap()
        };
        let pairs = |page: &ShadowReviewPage| {
            let mut pairs: Vec<_> = page
                .items
                .iter()
                .map(|i| (i.asset_id.clone(), i.target_id.clone()))
                .collect();
            pairs.sort();
            pairs
        };

        // No scope: the unchanged all-series list and counts.
        let all = scoped(None, None);
        assert_eq!(all.items.len(), 3);
        assert_eq!(all.summary.automatic.pending, 2);
        assert_eq!(all.summary.automatic.rejected, 1);
        assert_eq!(all.summary.recommended.pending, 1);
        assert_eq!(all.summary, page(&f, 0, 50).summary);

        let here_page = scoped(Some(&f.series), None);
        assert_eq!(
            pairs(&here_page),
            vec![
                ("asset-8".to_string(), here.id.clone()),
                ("asset-9".to_string(), here.id.clone()),
            ]
        );
        assert_eq!(
            here_page.summary.automatic,
            VerdictCounts {
                pending: 1,
                accepted: 0,
                rejected: 0
            }
        );
        assert_eq!(here_page.summary.recommended.pending, 1);
        assert_eq!(here_page.summary.by_origin["live"].automatic.pending, 1);
        assert_eq!(here_page.policy_version.as_deref(), Some("v1"));

        let there_page = scoped(Some(&f.child), None);
        assert_eq!(
            pairs(&there_page),
            vec![("asset-10".to_string(), there.id.clone())]
        );
        assert_eq!(
            there_page.summary.automatic,
            VerdictCounts {
                pending: 1,
                accepted: 0,
                rejected: 1
            }
        );
        assert_eq!(there_page.summary.recommended, VerdictCounts::default());

        // Paging stays inside the scope.
        let first = f
            .library
            .character_shadow_review_page(ShadowReviewQuery {
                offset: 0,
                limit: 1,
                mode: None,
                series_id: Some(f.series.clone()),
            })
            .unwrap();
        assert_eq!(first.next_offset, Some(1));
        assert_eq!(first.items[0].target_id, here.id);

        // A series without characters has nothing pending; the doubtful list scopes too.
        assert!(scoped(Some(&f.outside), None).items.is_empty());
        assert_eq!(
            scoped(Some(&f.outside), None).summary,
            ShadowReviewSummary::default()
        );
        assert!(scoped(Some(&f.series), Some("doubtful")).items.is_empty());
    }
    /// The shared contract with the status screen: `src/characters/learningRule.fixture.json`
    /// is also read by its vitest, which expects the same numbers.
    #[test]
    fn learning_rule_matches_the_shared_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/characters/learningRule.fixture.json"
        ))
        .unwrap();
        assert_eq!(fixture["readyReviewed"], READY_REVIEWED);
        assert_eq!(fixture["readyExamples"], READY_EXAMPLES);
        for case in fixture["cases"].as_array().unwrap() {
            let (judged, wrong, examples) = (
                case["judged"].as_u64().unwrap() as u32,
                case["wrong"].as_u64().unwrap() as u32,
                case["examples"].as_u64().unwrap() as u32,
            );
            assert_eq!(
                allowed_wrong(judged),
                case["allowed"].as_u64().unwrap() as u32,
                "{case}"
            );
            assert_eq!(
                readiness_status(judged, wrong, examples),
                case["status"],
                "{case}"
            );
        }
    }

    #[test]
    fn s36_readiness_status_thresholds() {
        assert_eq!(readiness_status(30, 1, 50), "learning");
        assert_eq!(readiness_status(29, 0, 80), "collecting");
        assert_eq!(readiness_status(40, 0, 49), "collecting");
        // allowed = max(1, floor(5% of judged))
        assert_eq!(
            (allowed_wrong(0), allowed_wrong(30), allowed_wrong(39)),
            (1, 1, 1)
        );
        assert_eq!(
            (allowed_wrong(40), allowed_wrong(60), allowed_wrong(100)),
            (2, 3, 5)
        );
        assert_eq!(readiness_status(30, 2, 80), "hold");
        assert_eq!(readiness_status(44, 2, 80), "learning");
        assert_eq!(readiness_status(44, 3, 80), "hold");
        assert_eq!(readiness_status(100, 5, 80), "learning");
        assert_eq!(readiness_status(100, 6, 80), "hold");
        // Too few judged or examples is still collecting, whatever the wrong count.
        assert_eq!(readiness_status(12, 2, 80), "collecting");
    }

    /// Links `tag` to the character; both taggers know it.
    fn link_tag(f: &Fixture, target: &Target, tag: &str) {
        let c = f.library.connection().unwrap();
        for source in ["pixai", "canary"] {
            c.execute(
                "INSERT OR IGNORE INTO tagger_character_vocabulary VALUES(?1,?2)",
                params![source, tag],
            )
            .unwrap();
        }
        c.execute(
            "INSERT OR IGNORE INTO character_target_tagger_tags VALUES(?1,?2)",
            params![target.id, tag],
        )
        .unwrap();
        f.library.character_changes.suggestion_inputs_changed();
    }

    /// What each tagger reads for `tag` on `asset` (`None`: it processed the image and read nothing).
    fn tagger_reads(f: &Fixture, asset: &str, tag: &str, pixai: Option<f64>, canary: Option<f64>) {
        let c = f.library.connection().unwrap();
        for (source, score) in [("pixai", pixai), ("canary", canary)] {
            c.execute(
                "INSERT OR IGNORE INTO asset_tagger_coverage VALUES(?1,?2)",
                params![asset, source],
            )
            .unwrap();
            if let Some(score) = score {
                c.execute(
                    "INSERT OR REPLACE INTO asset_tagger_character_scores VALUES(?1,?2,?3,?4)",
                    params![asset, source, tag, score],
                )
                .unwrap();
            }
        }
        f.library.character_changes.suggestion_inputs_changed();
    }

    const OLD: &str = "2026-01-01T00:00:00Z";

    /// A scored automatic candidate of the character, scored long before any decision.
    fn candidate(f: &Fixture, target: &Target, asset: &str) {
        let known: bool = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1)",
                [asset],
                |r| r.get(0),
            )
            .unwrap();
        if !known {
            series_asset(f, asset);
        }
        insert(
            f.temp.path(),
            &[(asset, &target.id, "automatic", 0.1, "v1", "none", OLD)],
        );
    }

    fn numbers(f: &Fixture, target: &Target) -> (u32, u32, u32, u32, u32, String) {
        let c = f.library.connection().unwrap();
        let cache = open_shadow_cache(f.temp.path()).unwrap();
        let row = readiness_of(&c, cache.as_ref(), std::slice::from_ref(&target.id)).unwrap();
        let row = &row[0];
        (
            row.reviewed,
            row.reviewed_auto,
            row.wrong,
            row.wrong_auto,
            row.examples,
            row.status.clone(),
        )
    }

    fn items_of(f: &Fixture, target: &Target) -> Vec<String> {
        let mut ids = page(f, 0, 200)
            .items
            .into_iter()
            .filter(|item| item.target_id == target.id)
            .map(|item| item.asset_id)
            .collect::<Vec<_>>();
        ids.sort();
        ids
    }

    fn agreed_placement_fixture() -> (Fixture, Target) {
        let f = Fixture::new();
        let target = f.ready("Toki");
        link_tag(&f, &target, "toki_tag");
        for asset in [
            "agreed-1",
            "agreed-2",
            "person-rejected",
            "one-tagger",
            "stale-hash",
        ] {
            candidate(&f, &target, asset);
            tagger_reads(
                &f,
                asset,
                "toki_tag",
                Some(0.85),
                Some(if asset == "one-tagger" { 0.849 } else { 0.999 }),
            );
            let c = f.library.connection().unwrap();
            c.execute(
                "INSERT INTO cloud_sync_queue(id,entity_type,entity_id,operation,status,revision,updated_at,synced_at)
                 VALUES(?1,'asset',?2,'upsert','synced',1,'now','now')",
                params![format!("queue-{asset}"), asset],
            ).unwrap();
        }
        decide(&f, &target, "person-rejected", DecisionKind::Rejected);
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET content_hash=?1 WHERE id='stale-hash'",
                ["f".repeat(64)],
            )
            .unwrap();
        (f, target)
    }

    #[test]
    fn agreed_pairs_are_placed_before_learning_owns_the_character_on_tagger_apply() {
        {
            let (f, target) = agreed_placement_fixture();
            {
                let c = f.library.connection().unwrap();
                assert!(!f
                    .library
                    .learning_targets(&c, &[target.id.clone()])
                    .owns(&target.id));
                // Existing pending rows are not returned by the next preview. The write
                // hook must reconcile them even when there is nothing new to apply.
                for asset in ["agreed-1", "agreed-2", "one-tagger", "stale-hash"] {
                    c.execute(
                        "INSERT INTO character_tagger_candidates SELECT ?1,id,content_hash,'recommendation',0.85,?3,'now' FROM assets WHERE id=?2",
                        params![target.id, asset, if asset == "one-tagger" { 0.849 } else { 0.999 }],
                    ).unwrap();
                }
            }
            // Warm the read projection before either write hook.
            assert!(items_of(&f, &target)
                .iter()
                .all(|asset| !asset.starts_with("agreed-")));
            let preview = f.library.preview_tagger_review().unwrap();
            assert_eq!(preview.recommend.count, 0);
            f.library
                .apply_tagger_review(&preview.preview_token)
                .unwrap();
            for asset in ["agreed-1", "agreed-2"] {
                assert_eq!(
                    f.library.character_relations_for_asset(asset).unwrap(),
                    [target.id.clone()]
                );
                let c = f.library.connection().unwrap();
                let (decision, origin, engine): (String, String, String) = c.query_row(
                    "SELECT decision,origin,json_extract(reference_snapshot,'$.prediction.engine')
                     FROM character_decisions WHERE target_id=?1 AND source_asset_id=?2",
                    params![target.id, asset], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                ).unwrap();
                assert_eq!(
                    (decision.as_str(), origin.as_str(), engine.as_str()),
                    ("accepted", "automatic", "s36")
                );
                let folders = c
                    .prepare(
                        "SELECT classification_id FROM asset_classifications WHERE asset_id=?1",
                    )
                    .unwrap()
                    .query_map([asset], |r| r.get::<_, String>(0))
                    .unwrap()
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .unwrap();
                assert_eq!(folders, [f.series.clone()]);
            }
            for asset in ["person-rejected", "one-tagger", "stale-hash"] {
                assert!(
                    f.library
                        .character_relations_for_asset(asset)
                        .unwrap()
                        .is_empty(),
                    "{asset}"
                );
            }
            assert!(items_of(&f, &target)
                .iter()
                .all(|asset| !asset.starts_with("agreed-")));
            assert_eq!(
                f.library
                    .tagger_review_items()
                    .unwrap()
                    .iter()
                    .map(|item| item.asset.id.as_str())
                    .collect::<Vec<_>>(),
                ["one-tagger"]
            );
            assert_eq!(f.library.character_confirm_counts(None).unwrap().tag, 1);
            assert!(f
                .library
                .character_review_feed_content()
                .unwrap()
                .items
                .iter()
                .all(|item| !item.asset_id.starts_with("agreed-")));
            // Repeating the hook is idempotent; automatic placements are not examples.
            let preview = f.library.preview_tagger_review().unwrap();
            f.library
                .apply_tagger_review(&preview.preview_token)
                .unwrap();
            let c = f.library.connection().unwrap();
            assert_eq!(
                c.query_row(
                    "SELECT COUNT(*) FROM character_decisions WHERE origin='automatic'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                2
            );
            drop(c);
            assert_eq!(
                f.library.character_s36_readiness(&f.series).unwrap()[0].examples,
                0
            );
            // 빼기 remains a person's decision and agreement must not re-add it.
            decide(&f, &target, "agreed-1", DecisionKind::Cleared);
            let preview = f.library.preview_tagger_review().unwrap();
            f.library
                .apply_tagger_review(&preview.preview_token)
                .unwrap();
            assert!(f
                .library
                .character_relations_for_asset("agreed-1")
                .unwrap()
                .is_empty());
        }
    }

    #[test]
    fn agreed_pairs_applied_as_new_recommendations_remain_subject_to_tagger_veto() {
        let f = Fixture::new();
        let target = f.ready("Toki");
        link_tag(&f, &target, "toki_tag");
        candidate(&f, &target, "agreed");
        tagger_reads(&f, "agreed", "toki_tag", Some(1.0), Some(0.999));
        let preview = f.library.preview_tagger_review().unwrap();
        assert_eq!(preview.recommend.count, 1);
        f.library
            .apply_tagger_review(&preview.preview_token)
            .unwrap();
        assert_eq!(
            f.library.character_relations_for_asset("agreed").unwrap(),
            [target.id.clone()]
        );
        tagger_reads(&f, "agreed", "toki_tag", Some(0.29), Some(0.29));
        let preview = f.library.preview_tagger_review().unwrap();
        assert_eq!(preview.veto.count, 1);
        f.library
            .apply_tagger_review(&preview.preview_token)
            .unwrap();
        assert!(f
            .library
            .character_relations_for_asset("agreed")
            .unwrap()
            .is_empty());
        // A later agreement cannot undo that veto automatically.
        tagger_reads(&f, "agreed", "toki_tag", Some(0.99), Some(0.99));
        let preview = f.library.preview_tagger_review().unwrap();
        f.library
            .apply_tagger_review(&preview.preview_token)
            .unwrap();
        assert!(f
            .library
            .character_relations_for_asset("agreed")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn the_taggers_judge_by_agreement_and_by_confident_disagreement() {
        let f = Fixture::new();
        let here = f.ready("Here");
        let other = f.ready("Other");
        let untagged = f.ready("Untagged");
        link_tag(&f, &here, "here_tag");
        link_tag(&f, &other, "other_tag");
        for id in ["x1", "x2", "x3", "x4", "x5", "x6", "x7"] {
            candidate(&f, &here, id);
        }
        // x1: both read Here. x2: only one tagger does, so nothing is judged. x3: both read the
        // other character and neither reads Here. x4: both read the other one, but one tagger also
        // reads Here, which is no disagreement.
        tagger_reads(&f, "x1", "here_tag", Some(0.9), Some(0.95));
        tagger_reads(&f, "x2", "here_tag", Some(0.9), Some(0.5));
        tagger_reads(&f, "x3", "other_tag", Some(0.9), Some(0.9));
        tagger_reads(&f, "x4", "other_tag", Some(0.9), Some(0.9));
        tagger_reads(&f, "x4", "here_tag", Some(0.9), None);
        // x5: both read Here but a person rejected it; x6: both read the other one but a person
        // accepted Here; x7: both read Here and a person accepted it. A person's judgment counts
        // once and in place of the taggers'.
        for id in ["x5", "x7"] {
            tagger_reads(&f, id, "here_tag", Some(0.9), Some(0.9));
        }
        tagger_reads(&f, "x6", "other_tag", Some(0.9), Some(0.9));
        candidate(&f, &here, "x8");
        tagger_reads(&f, "x8", "here_tag", Some(0.84), Some(0.9));
        decide(&f, &here, "x5", DecisionKind::Rejected);
        decide(&f, &here, "x6", DecisionKind::Accepted);
        decide(&f, &here, "x7", DecisionKind::Accepted);
        // Judged: x1 by the taggers (correct), x3 by the taggers (wrong), x5 by a person (wrong),
        // x6 and x7 by a person. x8 stays unjudged: 0.84 is below the 확실 line.
        // Examples are the two acceptances (x6, x7).
        assert_eq!(
            numbers(&f, &here),
            (5, 2, 2, 1, 2, "collecting".to_string())
        );
        // Without the taggers the rule counts the people's three alone.
        let c = f.library.connection().unwrap();
        let cache = open_shadow_cache(f.temp.path()).unwrap();
        let manual = judgments_of(&c, cache.as_ref(), &[here.id.clone()], Auto::Off)
            .unwrap()
            .readiness;
        assert_eq!((manual[0].reviewed, manual[0].wrong), (3, 1));
        drop(c);
        // A character without tagger tags gets no automatic judgment, though its peers' readings
        // are as sure as ever.
        candidate(&f, &untagged, "x3");
        assert_eq!(
            numbers(&f, &untagged),
            (0, 0, 0, 0, 0, "collecting".to_string())
        );
        // A character that only one tagger knows (no vocabulary for the other) gets none either.
        let lonely = f.ready("Lonely");
        {
            let c = f.library.connection().unwrap();
            c.execute(
                "INSERT OR IGNORE INTO tagger_character_vocabulary VALUES('pixai','lonely_tag')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO character_target_tagger_tags VALUES(?1,'lonely_tag')",
                [&lonely.id],
            )
            .unwrap();
        }
        candidate(&f, &lonely, "x3");
        assert_eq!(
            numbers(&f, &lonely),
            (0, 0, 0, 0, 0, "collecting".to_string())
        );
        // The other character was never scored by S36 here, so it has nothing to judge either.
        assert_eq!(
            numbers(&f, &other),
            (0, 0, 0, 0, 0, "collecting".to_string())
        );
    }

    #[test]
    fn a_character_reaches_learning_through_the_taggers_and_its_settled_pairs_leave_the_list() {
        let f = Fixture::new();
        let here = f.ready("Here");
        let other = f.ready("Other");
        link_tag(&f, &here, "here_tag");
        link_tag(&f, &other, "other_tag");
        {
            let c = f.library.connection().unwrap();
            seed_readiness(f.temp.path(), &c, &here.id, "v1", "e", (0, 0, 50));
        }
        let agreed = (0..29).map(|i| format!("ok-{i}")).collect::<Vec<_>>();
        for id in &agreed {
            candidate(&f, &here, id);
            tagger_reads(&f, id, "here_tag", Some(0.9), Some(0.9));
        }
        // One image a person has to look at: only one tagger reads it.
        candidate(&f, &here, "look");
        tagger_reads(&f, "look", "here_tag", Some(0.95), Some(0.2));
        let learning = || {
            let c = f.library.connection().unwrap();
            f.library
                .learning_targets(&c, &[here.id.clone()])
                .owns(&here.id)
        };
        assert_eq!(
            numbers(&f, &here),
            (29, 29, 0, 0, 50, "collecting".to_string())
        );
        assert!(!learning());
        // The agreeing pairs need nobody; the unsure one stays.
        assert_eq!(items_of(&f, &here), ["look"]);
        // The thirtieth agreement makes it learning, without anyone pressing a button.
        candidate(&f, &here, "ok-last");
        tagger_reads(&f, "ok-last", "here_tag", Some(0.9), Some(0.9));
        assert_eq!(
            numbers(&f, &here),
            (30, 30, 0, 0, 50, "learning".to_string())
        );
        assert!(learning());
        // A confident disagreement is one wrong; one is allowed at 30 judged, two are not.
        candidate(&f, &here, "no-1");
        tagger_reads(&f, "no-1", "other_tag", Some(0.9), Some(0.9));
        assert_eq!(
            numbers(&f, &here),
            (31, 31, 1, 1, 50, "learning".to_string())
        );
        candidate(&f, &here, "no-2");
        tagger_reads(&f, "no-2", "other_tag", Some(0.9), Some(0.9));
        assert_eq!(numbers(&f, &here), (32, 32, 2, 2, 50, "hold".to_string()));
        assert!(!learning());
        // Disagreeing pairs stay in the list for a person; so does the unsure one.
        assert_eq!(items_of(&f, &here), ["look", "no-1", "no-2"]);
        // A person's rejection of an agreeing pair replaces the automatic 맞음 (counted once).
        decide(&f, &here, "ok-0", DecisionKind::Rejected);
        assert_eq!(numbers(&f, &here), (32, 31, 3, 2, 50, "hold".to_string()));
        // The tagger examples never lift the example count.
        assert_eq!(numbers(&f, &here).4, 50);
    }

    #[test]
    fn placed_items_of_a_learning_character_leave_the_list_and_those_of_others_stay() {
        let f = Fixture::new();
        let ready = f.ready("Ready");
        let waiting = f.ready("Waiting");
        {
            let c = f.library.connection().unwrap();
            seed_readiness(f.temp.path(), &c, &ready.id, "v1", "r", (30, 0, 20));
            seed_readiness(f.temp.path(), &c, &waiting.id, "v1", "w", (3, 0, 40));
        }
        for (target, id) in [(&ready, "placed-r"), (&waiting, "placed-w")] {
            series_asset(&f, id);
            insert(
                f.temp.path(),
                &[(
                    id,
                    &target.id,
                    "automatic",
                    0.1,
                    "v1",
                    "accepted_automatic",
                    OLD,
                )],
            );
        }
        for (target, id) in [(&ready, "fresh-r"), (&waiting, "fresh-w")] {
            candidate(&f, target, id);
        }
        assert_eq!(numbers(&f, &ready).5, "learning");
        assert_eq!(numbers(&f, &waiting).5, "collecting");
        assert_eq!(items_of(&f, &ready), ["fresh-r"]);
        assert_eq!(items_of(&f, &waiting), ["fresh-w", "placed-w"]);
    }

    #[test]
    fn confirm_counts_leave_out_settled_pairs_and_fold_far_characters() {
        let f = Fixture::new();
        let far = f.ready("Far");
        let near = f.ready("Near");
        link_tag(&f, &near, "near_tag");
        {
            let c = f.library.connection().unwrap();
            // Far: nothing judged, 29 examples. Near: 30 examples.
            seed_readiness(
                f.temp.path(),
                &c,
                &far.id,
                "v1",
                "f",
                (0, 0, NEAR_EXAMPLES - 1),
            );
            seed_readiness(
                f.temp.path(),
                &c,
                &near.id,
                "v1",
                "n",
                (0, 0, NEAR_EXAMPLES),
            );
        }
        for (target, id) in [
            (&far, "far-1"),
            (&far, "far-2"),
            (&near, "near-1"),
            (&near, "near-2"),
        ] {
            candidate(&f, target, id);
        }
        // near-2 is settled by the taggers' agreement.
        tagger_reads(&f, "near-2", "near_tag", Some(0.9), Some(0.9));
        let page = page(&f, 0, 50);
        let folded = |target: &Target, asset: &str| {
            page.items
                .iter()
                .find(|item| item.target_id == target.id && item.asset_id == asset)
                .map(|item| item.folded)
        };
        assert_eq!(folded(&far, "far-1"), Some(true));
        assert_eq!(folded(&near, "near-1"), Some(false));
        assert_eq!(folded(&near, "near-2"), None);
        let totals = f.library.confirm_totals(None).unwrap();
        assert_eq!(
            totals,
            ConfirmTotals {
                counts: ConfirmCounts {
                    recognition: 1,
                    tag: 0,
                    recheck: 0
                },
                folded_items: 2,
                folded_characters: 1,
            }
        );
        assert_eq!(
            f.library.character_confirm_counts(None).unwrap(),
            totals.counts
        );
        // Tag recommendations and rechecks of a far character always count; the settled pair
        // does not, even when the tag list brings it up.
        {
            let c = f.library.connection().unwrap();
            for (target, asset, reason) in [
                (&far.id, "far-1", "recommendation"),
                (&near.id, "near-2", "recommendation"),
            ] {
                c.execute(
                    "INSERT INTO character_tagger_candidates(target_id,asset_id,asset_hash,reason,pixai_score,canary_score,created_at)
                     VALUES(?1,?2,?3,?4,0.9,0.9,'now')",
                    params![target, asset, content_hash(asset), reason],
                )
                .unwrap();
            }
        }
        // The tag list itself leaves the settled pair out too.
        let listed = f
            .library
            .tagger_review_items()
            .unwrap()
            .into_iter()
            .map(|item| (item.target_id, item.asset.id))
            .collect::<Vec<_>>();
        assert_eq!(listed, [(far.id.clone(), "far-1".to_string())]);
        let totals = f.library.confirm_totals(None).unwrap();
        assert_eq!(
            (
                totals.counts.recognition,
                totals.counts.tag,
                totals.counts.recheck,
                totals.folded_items
            ),
            // far-1 is now a tag recommendation, so it is no longer folded; far-2 still is.
            (1, 1, 0, 1)
        );
        // A far character that gets a judged tail steps out of the fold.
        {
            let c = f.library.connection().unwrap();
            seed_readiness(f.temp.path(), &c, &far.id, "v1", "g", (NEAR_JUDGED, 0, 0));
        }
        let totals = f.library.confirm_totals(None).unwrap();
        assert_eq!((totals.counts.recognition, totals.folded_items), (3, 0));
    }

    #[test]
    fn the_overview_threshold_is_judged_fifteen_or_thirty_examples() {
        assert!(!is_close_to_switching(NEAR_JUDGED - 1, NEAR_EXAMPLES - 1));
        assert!(is_close_to_switching(NEAR_JUDGED, 0));
        assert!(is_close_to_switching(0, NEAR_EXAMPLES));
        assert_eq!((NEAR_JUDGED, NEAR_EXAMPLES), (15, 30));
    }

    #[test]
    fn readiness_rows_follow_the_shared_fixture_with_the_automatic_cases() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/characters/learningRule.fixture.json"
        ))
        .unwrap();
        for case in fixture["automaticCases"].as_array().unwrap() {
            let n = |key: &str| case[key].as_u64().unwrap() as u32;
            let row = readiness_row(
                "t",
                (n("manual"), n("wrongManual")),
                (n("auto"), n("wrongAuto")),
                n("examples"),
            );
            assert_eq!(row.reviewed, n("judged"), "{case}");
            assert_eq!(row.reviewed_auto, n("auto"), "{case}");
            assert_eq!(row.wrong, n("wrong"), "{case}");
            assert_eq!(row.wrong_auto, n("wrongAuto"), "{case}");
            assert_eq!(row.allowed, n("allowed"), "{case}");
            assert_eq!(row.status, case["status"], "{case}");
        }
    }

    fn review_query(offset: u32, limit: u32, series_id: Option<&str>) -> ShadowReviewQuery {
        ShadowReviewQuery {
            offset,
            limit,
            mode: None,
            series_id: series_id.map(Into::into),
        }
    }

    fn prepared_lists(f: &Fixture) -> usize {
        f.library
            .character_changes
            .shadow_review
            .prepared_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// The cached page, after checking it against the page computed from scratch.
    fn checked_page(f: &Fixture, query: impl Fn() -> ShadowReviewQuery) -> serde_json::Value {
        let cached =
            serde_json::to_value(f.library.character_shadow_review_page(query()).unwrap()).unwrap();
        let fresh = serde_json::to_value(
            f.library
                .character_shadow_review_page_uncached(query())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(cached, fresh);
        cached
    }

    /// A ready character with five scored series images.
    fn cached_review_fixture() -> (Fixture, Target) {
        let f = Fixture::new();
        let target = f.ready("Cached");
        let at = "2026-09-23T01:00:00Z";
        let ids: Vec<String> = (0..5).map(|i| format!("cached-{i}")).collect();
        for id in &ids {
            series_asset(&f, id);
        }
        let rows: Vec<_> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| {
                let verdict = if i % 2 == 0 {
                    "automatic"
                } else {
                    "recommended"
                };
                (
                    id.as_str(),
                    target.id.as_str(),
                    verdict,
                    0.1,
                    "v1",
                    "none",
                    at,
                )
            })
            .collect();
        insert(f.temp.path(), &rows);
        (f, target)
    }

    fn summary_fixture() -> (Fixture, Target) {
        let (f, _) = cached_review_fixture();
        let target = f.ready_in_series("Summary", &f.series);
        Connection::open(f.temp.path().join(".cache/characters/s36_shadow.sqlite"))
            .unwrap()
            .execute("UPDATE scores SET target_id=?1", [&target.id])
            .unwrap();
        {
            let c = f.library.connection().unwrap();
            seed_readiness(
                f.temp.path(),
                &c,
                &target.id,
                "v1",
                "summary",
                (0, 0, READY_EXAMPLES),
            );
        }
        (f, target)
    }

    #[test]
    fn character_summary_shadow_reads_release_library_connection() {
        let (f, target) = summary_fixture();
        decide(&f, &target, "cached-0", DecisionKind::Accepted);
        let library = f.library.clone();
        let phases = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = phases.clone();
        struct ResetHook;
        impl Drop for ResetHook {
            fn drop(&mut self) {
                SHADOW_READ_HOOK.with(|hook| *hook.borrow_mut() = None);
            }
        }
        let _reset = ResetHook;
        SHADOW_READ_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                // Block this shadow phase until another thread actually obtains the connection.
                // A held connection causes a bounded failure instead of hanging the test.
                let other = library.clone();
                let (send, receive) = std::sync::mpsc::channel();
                std::thread::spawn(move || {
                    let connection = other.connection().unwrap();
                    let _ = send.send(
                        connection
                            .query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
                            .unwrap(),
                    );
                });
                assert_eq!(
                    receive
                        .recv_timeout(std::time::Duration::from_secs(2))
                        .unwrap(),
                    1
                );
                seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }))
        });
        f.library.confirm_totals(Some(&f.series)).unwrap();
        let after_totals = phases.load(std::sync::atomic::Ordering::Relaxed);
        assert!(
            after_totals >= 4,
            "opens, policy and score lookups must be exercised"
        );
        f.library.character_s36_readiness(&f.series).unwrap();
        assert!(phases.load(std::sync::atomic::Ordering::Relaxed) > after_totals);
        SHADOW_READ_HOOK.with(|hook| *hook.borrow_mut() = None);
    }

    fn checked_summaries(f: &Fixture) -> (ConfirmTotals, Vec<S36Readiness>) {
        let actual = (
            f.library.confirm_totals(Some(&f.series)).unwrap(),
            f.library.character_s36_readiness(&f.series).unwrap(),
        );
        let candidates = shadow_rows(f.temp.path(), false).unwrap().map(Arc::new);
        let doubtful = shadow_rows(f.temp.path(), true).unwrap().map(Arc::new);
        let cache = open_shadow_cache(f.temp.path()).unwrap();
        let c = f.library.connection().unwrap();
        let expected = confirm_totals_of(
            &c,
            cache.as_ref(),
            candidates.as_ref(),
            doubtful.as_ref(),
            pending_tag_rows(&c, Some(&f.series)).unwrap(),
            Some(&f.series),
        )
        .unwrap();
        let targets = c.prepare("SELECT id FROM character_targets WHERE role='character' AND series_classification_id=?1 ORDER BY id").unwrap()
            .query_map([&f.series], |r| r.get::<_, String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        assert_eq!(actual.0, expected);
        assert_eq!(
            actual.1,
            readiness_of(&c, cache.as_ref(), &targets).unwrap()
        );
        actual
    }

    #[test]
    fn character_summary_cache_golden_and_invalidation() {
        let (f, target) = summary_fixture();
        let computes = || {
            f.library
                .character_changes
                .shadow_review
                .summary_count
                .load(std::sync::atomic::Ordering::Relaxed)
        };
        let initial = checked_summaries(&f);
        assert_eq!(
            initial.0.counts,
            ConfirmCounts {
                recognition: 5,
                tag: 0,
                recheck: 0
            }
        );
        let readiness = initial
            .1
            .iter()
            .find(|row| row.target_id == target.id)
            .unwrap();
        assert_eq!(readiness.reviewed, 0);
        assert_eq!(readiness.examples, READY_EXAMPLES);
        assert_eq!(computes(), 2);
        assert_eq!(checked_summaries(&f), initial);
        assert_eq!(
            computes(),
            2,
            "unchanged inputs compute neither result again"
        );
        let mut expected = 2;
        let mut step = |change: &dyn Fn()| {
            change();
            let result = checked_summaries(&f);
            expected += 2;
            assert_eq!(computes(), expected);
            assert_eq!(checked_summaries(&f), result);
            assert_eq!(computes(), expected);
            result
        };
        let accepted = step(&|| decide(&f, &target, "cached-0", DecisionKind::Accepted));
        assert_eq!(accepted.0.counts.recognition, 4);
        assert_eq!(
            accepted
                .1
                .iter()
                .find(|row| row.target_id == target.id)
                .unwrap()
                .reviewed,
            1
        );
        step(&|| decide(&f, &target, "cached-1", DecisionKind::Rejected));
        step(&|| {
            f.library
                .connection()
                .unwrap()
                .execute(
                    "UPDATE character_targets SET manual_only=1 WHERE id=?1",
                    [&target.id],
                )
                .unwrap();
        });
        step(&|| f.library.set_character_broad_folder_scope(true).unwrap());
        // WITHOUT ROWID candidates change only the existing publication revision.
        step(&|| {
            f.library.connection().unwrap().execute("INSERT INTO character_tagger_candidates VALUES(?1,'cached-2',?2,'veto',0.9,0.9,'now')", params![target.id, content_hash("cached-2")]).unwrap();
        });
        step(&|| {
            f.library
                .connection()
                .unwrap()
                .execute(
                    "DELETE FROM character_tagger_candidates WHERE target_id=?1",
                    [&target.id],
                )
                .unwrap();
        });
        step(&|| link_tag(&f, &target, "summary_tag"));
        step(&|| tagger_reads(&f, "cached-2", "summary_tag", Some(0.9), Some(0.9)));
        // Same-sized score rewrite must move the file stamp even without a library write.
        step(&|| {
            Connection::open(f.temp.path().join(".cache/characters/s36_shadow.sqlite"))
                .unwrap()
                .execute(
                    "UPDATE scores SET scored_at='2026-10-01T01:00:00Z' WHERE asset_id='cached-2'",
                    [],
                )
                .unwrap();
        });
        step(&|| f.library.character_changes.database_replaced());
    }

    #[test]
    fn character_shadow_review_pages_slice_one_cached_list() {
        let (f, _) = cached_review_fixture();
        let whole = checked_page(&f, || review_query(0, 50, None));
        assert_eq!(whole["items"].as_array().unwrap().len(), 5);
        assert_eq!(prepared_lists(&f), 1);
        let mut sliced = Vec::new();
        for offset in [0, 2, 4] {
            let page = checked_page(&f, || review_query(offset, 2, None));
            assert_eq!(page["summary"], whole["summary"]);
            assert_eq!(page["policyVersion"], whole["policyVersion"]);
            sliced.extend(page["items"].as_array().unwrap().iter().cloned());
        }
        assert_eq!(&sliced, whole["items"].as_array().unwrap());
        // Every page, and the same page again, came from the one computation.
        assert_eq!(prepared_lists(&f), 1);
        let series = f.series.clone();
        checked_page(&f, || review_query(0, 1, Some(&series)));
        checked_page(&f, || review_query(1, 1, Some(&series)));
        assert_eq!(prepared_lists(&f), 2, "one list per series scope");
        let doubtful = || ShadowReviewQuery {
            mode: Some("doubtful".into()),
            ..review_query(0, 50, None)
        };
        checked_page(&f, doubtful);
        checked_page(&f, doubtful);
        assert_eq!(prepared_lists(&f), 3, "one list per mode");
    }

    #[test]
    fn character_shadow_review_cache_follows_every_input() {
        let (f, target) = cached_review_fixture();
        let series = f.series.clone();
        let all = || review_query(0, 50, None);
        let scoped = || review_query(0, 50, Some(&series));
        let count = |page: &serde_json::Value| page["items"].as_array().unwrap().len();
        // Each change recomputes the list once, and the result matches a fresh computation.
        let mut expected = 0;
        let mut step = |label: &str, change: &dyn Fn()| -> serde_json::Value {
            change();
            let page = checked_page(&f, all);
            expected += 1;
            assert_eq!(prepared_lists(&f), expected, "{label}");
            // Unchanged inputs: served from the cache.
            assert_eq!(checked_page(&f, all), page, "{label}");
            assert_eq!(prepared_lists(&f), expected, "{label} (repeat)");
            page
        };
        assert_eq!(count(&step("first read", &|| ())), 5);

        let page = step("manual decision", &|| {
            decide(&f, &target, "cached-0", DecisionKind::Accepted)
        });
        assert_eq!(count(&page), 4);

        let page = step("rejection", &|| {
            decide(&f, &target, "cached-1", DecisionKind::Rejected)
        });
        assert_eq!(count(&page), 3);

        let page = step("Asset moved to the trash", &|| {
            f.library
                .connection()
                .unwrap()
                .execute("UPDATE assets SET status='trash' WHERE id='cached-2'", [])
                .unwrap();
        });
        assert_eq!(count(&page), 2);

        let page = step("Asset filed outside every series", &|| {
            f.library
                .connection()
                .unwrap()
                .execute(
                    "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='cached-3'",
                    [&f.outside],
                )
                .unwrap();
        });
        assert_eq!(count(&page), 1);

        let page = step("broad-folder rule on", &|| {
            f.library.set_character_broad_folder_scope(true).unwrap()
        });
        assert_eq!(count(&page), 2);

        let page = step("S36 shadow cache rewritten", &|| {
            series_asset(&f, "cached-5");
            insert(
                f.temp.path(),
                &[(
                    "cached-5",
                    target.id.as_str(),
                    "automatic",
                    0.1,
                    "v1",
                    "none",
                    "2026-09-23T02:00:00Z",
                )],
            );
        });
        assert_eq!(count(&page), 3);

        // Series membership: the series-scoped list follows the character out of the series.
        assert_eq!(count(&checked_page(&f, scoped)), 3);
        expected += 1;
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE character_targets SET series_classification_id=?1 WHERE id=?2",
                [&f.child, &target.id],
            )
            .unwrap();
        assert_eq!(count(&checked_page(&f, scoped)), 0);
        expected += 1;
        assert_eq!(prepared_lists(&f), expected);
    }

    #[test]
    fn character_shadow_review_cache_reads_characters_on_every_call() {
        let (f, target) = cached_review_fixture();
        let all = || review_query(0, 50, None);
        let before = checked_page(&f, all);
        let references = before["items"][0]["referenceAssetIds"].clone();
        assert!(!references.as_array().unwrap().is_empty());
        // A reference original disappears: no library table changes, yet the items follow.
        let removed = references[0].as_str().unwrap();
        std::fs::remove_file(f.temp.path().join(format!("assets/{removed}.png"))).unwrap();
        let after = checked_page(&f, all);
        assert_ne!(after["items"][0]["referenceAssetIds"], references);
        assert_eq!(prepared_lists(&f), 1);
        // Disabling the character empties the list and its pending counts.
        let current = f.library.list_character_targets().unwrap();
        let current = current.iter().find(|t| t.id == target.id).unwrap();
        f.library
            .save_character_target(super::super::characters::TargetDraft {
                id: Some(current.id.clone()),
                expected_revision: Some(current.revision),
                series_classification_id: current.series_classification_id.clone(),
                linked_classification_id: current.linked_classification_id.clone(),
                display_name: current.display_name.clone(),
                description: current.description.clone(),
                thumbnail_asset_id: current.thumbnail_asset_id.clone(),
                enabled: false,
            })
            .unwrap();
        let disabled = checked_page(&f, all);
        assert_eq!(disabled["items"].as_array().unwrap().len(), 0);
        assert_eq!(disabled["summary"]["automatic"]["pending"], 0);
    }

    #[test]
    fn character_shadow_review_concurrent_requests_compute_once() {
        let (f, _) = cached_review_fixture();
        let barrier = std::sync::Barrier::new(8);
        let pages = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|i| {
                    let (library, barrier) = (&f.library, &barrier);
                    scope.spawn(move || {
                        barrier.wait();
                        serde_json::to_value(
                            library
                                .character_shadow_review_page(review_query(i % 3, 2, None))
                                .unwrap(),
                        )
                        .unwrap()
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(prepared_lists(&f), 1);
        for (i, page) in pages.iter().enumerate() {
            let fresh = f
                .library
                .character_shadow_review_page_uncached(review_query(i as u32 % 3, 2, None))
                .unwrap();
            assert_eq!(page, &serde_json::to_value(fresh).unwrap());
        }
    }

    #[test]
    fn s36_readiness_counts_judged_automatic_candidates() {
        let (f, target) = cached_review_fixture();
        decide(&f, &target, "cached-0", DecisionKind::Accepted);
        decide(&f, &target, "cached-2", DecisionKind::Rejected);
        decide(&f, &target, "cached-1", DecisionKind::Rejected); // recommended: not counted
        decide(&f, &target, "cached-4", DecisionKind::Accepted);
        decide(&f, &target, "cached-4", DecisionKind::Cleared);
        let readiness = f.library.character_s36_readiness(&f.series).unwrap();
        let row = readiness.iter().find(|r| r.target_id == target.id).unwrap();
        assert_eq!((row.reviewed, row.wrong), (2, 1));
        assert_eq!((row.examples, row.allowed), (1, 1));
        assert_eq!(row.status, "collecting");
    }

    #[test]
    fn learning_follows_the_ratio_rule_falls_back_and_returns() {
        let f = Fixture::new();
        let target = f.ready("Ratio");
        let id = target.id.clone();
        let learning = || {
            let c = f.library.connection().unwrap();
            f.library.learning_targets(&c, &[id.clone()]).owns(&id)
        };
        let status = || {
            let row = f.library.character_s36_readiness(&f.series).unwrap();
            let row = row.into_iter().find(|r| r.target_id == id).unwrap();
            (
                row.reviewed,
                row.wrong,
                row.allowed,
                row.examples,
                row.status,
            )
        };
        let seed = |tag: &str, counts: (u32, u32, u32)| {
            let c = f.library.connection().unwrap();
            seed_readiness(f.temp.path(), &c, &id, "v1", tag, counts);
        };
        // No score cache at all: nobody is learning, and the readiness read does not fail.
        assert!(!learning());
        assert_eq!(status().4, "collecting");
        // 30 judged (1 wrong) but only 49 examples.
        seed("a", (29, 1, 20));
        assert_eq!(status(), (30, 1, 1, 49, "collecting".into()));
        assert!(!learning());
        seed("b", (0, 0, 1));
        assert_eq!(status(), (30, 1, 1, 50, "learning".into()));
        assert!(learning());
        // One more wrong exceeds the allowance of 1: back to 기본 인식.
        seed("c", (0, 1, 0));
        assert_eq!(status(), (31, 2, 1, 50, "hold".into()));
        assert!(!learning());
        // The allowance grows with the judgments (40 judged allow 2): it returns by itself.
        seed("d", (8, 0, 0));
        assert!(!learning());
        seed("e", (1, 0, 0));
        assert_eq!(status(), (40, 2, 2, 59, "learning".into()));
        assert!(learning());
        // Manual-only and switched-off characters are never placed automatically.
        let c = f.library.connection().unwrap();
        c.execute(
            "UPDATE character_targets SET manual_only=1 WHERE id=?1",
            [&id],
        )
        .unwrap();
        drop(c);
        assert!(!learning());
        let c = f.library.connection().unwrap();
        c.execute(
            "UPDATE character_targets SET manual_only=0,enabled=0 WHERE id=?1",
            [&id],
        )
        .unwrap();
        drop(c);
        assert!(!learning());
    }

    #[test]
    fn a_judgment_made_before_the_scoring_or_for_another_policy_does_not_count() {
        let f = Fixture::new();
        let target = f.ready("Early");
        {
            let c = f.library.connection().unwrap();
            seed_readiness(f.temp.path(), &c, &target.id, "old", "old", (35, 0, 60));
        }
        let ready = |f: &Fixture| {
            f.library.character_s36_readiness(&f.series).unwrap()[0]
                .status
                .clone()
        };
        assert_eq!(ready(&f), "learning");
        // A newer policy rescored everything later than the decisions were made.
        let cache =
            Connection::open(f.temp.path().join(".cache/characters/s36_shadow.sqlite")).unwrap();
        cache
            .execute(
                "UPDATE scores SET policy_version='new',scored_at='2026-03-01T00:00:00Z'",
                [],
            )
            .unwrap();
        assert_eq!(ready(&f), "collecting");
        // Judged again after the new scoring: counted again.
        cache
            .execute("UPDATE scores SET scored_at='2026-01-15T00:00:00Z'", [])
            .unwrap();
        assert_eq!(ready(&f), "learning");
    }

    /// The judgments as they were computed with one query per character; the oracle for the
    /// bulk reads of [`judgments_of`].
    fn legacy_judgments_of(
        c: &Connection,
        cache: Option<&Connection>,
        targets: &[String],
        auto: Auto,
    ) -> Judgments {
        let version = cache.and_then(|cache| newest_policy(cache).unwrap());
        let mut examples = c
            .prepare(
                "SELECT COUNT(*) FROM (SELECT d.source_asset_id,
                   (SELECT x.decision FROM character_decisions x WHERE x.target_id=d.target_id AND x.source_asset_id=d.source_asset_id ORDER BY x.sequence DESC LIMIT 1) AS latest
                 FROM character_decisions d WHERE d.target_id=?1 AND d.origin='manual' GROUP BY d.source_asset_id)
                 WHERE latest='accepted'",
            )
            .unwrap();
        let example_counts = targets
            .iter()
            .map(|target| examples.query_row([target], |r| r.get::<_, u32>(0)).unwrap())
            .collect::<Vec<_>>();
        let signals = if version.is_none() {
            HashMap::new()
        } else {
            let wanted = targets
                .iter()
                .zip(&example_counts)
                .filter(|(_, count)| match auto {
                    Auto::Off => false,
                    Auto::ReadyOnly => **count >= READY_EXAMPLES,
                    Auto::Full => true,
                })
                .map(|(target, _)| target.clone())
                .collect::<Vec<_>>();
            if wanted.is_empty() {
                HashMap::new()
            } else {
                tagger_signals(c, &wanted).unwrap()
            }
        };
        let mut agreed = HashMap::new();
        let mut result = Vec::new();
        for (target, examples) in targets.iter().zip(example_counts) {
            let (mut manual, mut manual_wrong) = (0u32, 0u32);
            let (mut judged_auto, mut wrong_auto) = (0u32, 0u32);
            if let (Some(version), Some(cache)) = (&version, cache) {
                let scored_at = |asset: &str| -> Option<String> {
                    cache
                        .query_row(
                            "SELECT scored_at FROM scores WHERE asset_id=?1 AND target_id=?2 AND policy_version=?3 AND verdict='automatic'",
                            params![asset, target, version],
                            |r| r.get(0),
                        )
                        .optional()
                        .unwrap()
                };
                let mut latest = HashMap::<String, (String, String)>::new();
                let mut seen = BTreeSet::new();
                let rows = c
                    .prepare(
                        "SELECT d.source_asset_id,d.decision,d.created_at FROM character_decisions d
                         WHERE d.target_id=?1 AND d.origin='manual' ORDER BY d.source_asset_id,d.sequence DESC",
                    )
                    .unwrap()
                    .query_map([target], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    })
                    .unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap();
                for (asset, decision, at) in rows {
                    if seen.insert(asset.clone()) && decision != "cleared" {
                        latest.insert(asset, (decision, at));
                    }
                }
                for (asset, (decision, at)) in &latest {
                    if scored_at(asset).is_some_and(|scored| *at > scored) {
                        manual += 1;
                        manual_wrong += u32::from(decision == "rejected");
                    }
                }
                if let Some(signals) = signals.get(target) {
                    let mut settled = BTreeSet::new();
                    for (assets, correct) in [(&signals.agree, true), (&signals.disagree, false)] {
                        for asset in assets {
                            let Some(scored) = scored_at(asset) else {
                                continue;
                            };
                            match latest.get(asset) {
                                Some((_, at)) if *at > scored => continue,
                                Some((decision, _)) if decision == "rejected" => continue,
                                Some(_) if !correct => continue,
                                _ => {}
                            }
                            judged_auto += 1;
                            if correct {
                                settled.insert(asset.clone());
                            } else {
                                wrong_auto += 1;
                            }
                        }
                    }
                    agreed.insert(target.clone(), settled);
                }
            }
            result.push(readiness_row(
                target,
                (manual, manual_wrong),
                (judged_auto, wrong_auto),
                examples,
            ));
        }
        Judgments {
            readiness: result,
            agreed,
        }
    }

    fn automatic_decision(f: &Fixture, target: &Target, asset: &str, decision: &str, at: &str) {
        f.library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
                 VALUES(?1,?2,?2,?3,?4,'native','{}','automatic',?5)",
                params![target.id, asset, content_hash(asset), decision, at],
            )
            .unwrap();
    }

    #[test]
    fn judgments_read_in_bulk_equal_the_per_character_reads() {
        let f = Fixture::new();
        let here = f.ready("Here");
        let other = f.ready("Other");
        link_tag(&f, &here, "here_tag");
        link_tag(&f, &other, "other_tag");
        for id in ["j0", "j1", "j2", "j3", "j4", "j5", "j6", "j7", "j8"] {
            candidate(&f, &here, id);
        }
        candidate(&f, &other, "j1");
        candidate(&f, &other, "j4");
        // j0: both taggers read Here. j1: both read Other. j2: one tagger reads Here. j3 to j7:
        // both read Here, then people and the native pass decide in different ways.
        tagger_reads(&f, "j0", "here_tag", Some(0.9), Some(0.9));
        tagger_reads(&f, "j1", "other_tag", Some(0.9), Some(0.9));
        tagger_reads(&f, "j2", "here_tag", Some(0.9), Some(0.2));
        for id in ["j3", "j4", "j5", "j6", "j7"] {
            tagger_reads(&f, id, "here_tag", Some(0.9), Some(0.9));
        }
        tagger_reads(&f, "j8", "other_tag", Some(0.9), Some(0.9));
        decide(&f, &here, "j3", DecisionKind::Rejected);
        decide(&f, &here, "j4", DecisionKind::Accepted);
        decide(&f, &here, "j5", DecisionKind::Accepted);
        decide(&f, &here, "j5", DecisionKind::Cleared);
        // j6: accepted by a person, then rejected by the native pass (the newest decision of
        // any origin is no acceptance, so it is not an example). j7: only the native pass.
        decide(&f, &here, "j6", DecisionKind::Accepted);
        automatic_decision(&f, &here, "j6", "rejected", "2999-01-01T00:00:00Z");
        automatic_decision(&f, &here, "j7", "accepted", "2999-01-01T00:00:00Z");
        // Scored after the person's decision: the decision does not count against it.
        series_asset(&f, "j9");
        decide(&f, &here, "j9", DecisionKind::Rejected);
        insert(
            f.temp.path(),
            &[(
                "j9",
                &here.id,
                "automatic",
                0.1,
                "v1",
                "none",
                "2999-06-01T00:00:00Z",
            )],
        );

        let cache = open_shadow_cache(f.temp.path()).unwrap();
        let c = f.library.connection().unwrap();
        let targets = vec![here.id.clone(), other.id.clone(), "missing".to_string()];
        for auto in [Auto::Off, Auto::ReadyOnly, Auto::Full] {
            let bulk = judgments_of(&c, cache.as_ref(), &targets, auto).unwrap();
            let legacy = legacy_judgments_of(&c, cache.as_ref(), &targets, auto);
            assert_eq!(bulk.readiness, legacy.readiness, "{auto:?}");
            assert_eq!(bulk.agreed, legacy.agreed, "{auto:?}");
        }
        let full = judgments_of(&c, cache.as_ref(), &targets, Auto::Full).unwrap();
        // The scenario must exercise what it compares: judged pairs, examples, agreements.
        assert!(full.readiness[0].reviewed >= 4, "{:?}", full.readiness[0]);
        // Only j4 is an example: j5 was cleared, j6's newest decision is a native rejection, j9 is rejected.
        assert_eq!(full.readiness[0].examples, 1);
        assert!(full.agreed[&here.id].contains("j0"));
        // Without a score cache only the examples are counted.
        let without = judgments_of(&c, None, &targets, Auto::Full).unwrap();
        let legacy = legacy_judgments_of(&c, None, &targets, Auto::Full);
        assert_eq!(without.readiness, legacy.readiness);
        assert_eq!(without.agreed, legacy.agreed);
    }

    /// More scored pairs than one read batch holds: the doubtful list narrows to the natively
    /// accepted pairs first and reads their decisions in one pass. Both lists, the counts and
    /// the summary must equal what the pre-batching reads gave.
    #[test]
    fn lists_longer_than_a_read_batch_equal_the_legacy_lists() {
        let f = Fixture::new();
        let here = f.ready("Many");
        let total = READ_BATCH_ROWS * 2 + 37;
        {
            let c = f.library.connection().unwrap();
            let tx = c.unchecked_transaction().unwrap();
            for index in 0..total {
                let id = format!("many-{index:05}");
                tx.execute(
                    "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
                     VALUES(?1,?2,'image',?1,'assets/'||?1||'.png','thumbnails/'||?1||'.webp',7,3,2,'2026-09-08','normal')",
                    params![id, content_hash(&id)],
                )
                .unwrap();
                tx.execute(
                    "INSERT INTO asset_classifications VALUES(?1,?2)",
                    params![id, f.series],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        }
        super::super::character_shadow::Cache::open(f.temp.path()).unwrap();
        {
            let cache =
                Connection::open(f.temp.path().join(".cache/characters/s36_shadow.sqlite"))
                    .unwrap();
            let tx = cache.unchecked_transaction().unwrap();
            for index in 0..total {
                let id = format!("many-{index:05}");
                // Mostly nothing found; some recommended, a few automatic.
                let verdict = match index % 25 {
                    0 => "recommended",
                    1 => "automatic",
                    _ => "none",
                };
                tx.execute(
                    "INSERT INTO scores(asset_id,content_hash,target_id,knn3,verdict,policy_version,feature_id,native_outcome,native_at,scored_at,prior_manual_rejections)
                     VALUES(?1,?2,?3,0.1,?4,'many-v1','feature','none','2026-09-29T00:00:00Z','2026-09-29T00:00:00Z',100)",
                    params![id, content_hash(&id), here.id, verdict],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        }
        // The native pass accepted every 7th pair; for every 21st of those a later native
        // rejection replaced it, and a person rejected every 35th.
        for index in (0..total).step_by(7) {
            let id = format!("many-{index:05}");
            automatic_decision(&f, &here, &id, "accepted", "2026-08-01T00:00:00Z");
            if index % 21 == 0 {
                automatic_decision(&f, &here, &id, "rejected", "2026-08-02T00:00:00Z");
            }
        }
        for index in (0..total).step_by(35) {
            decide(&f, &here, &format!("many-{index:05}"), DecisionKind::Rejected);
        }

        for mode in [None, Some("doubtful")] {
            let legacy = legacy_items(&f.library, mode, None);
            assert!(!legacy.items.is_empty());
            assert_eq!(items_in(&f.library, mode, None), legacy, "mode={mode:?}");
        }
        let doubtful = legacy_items(&f.library, Some("doubtful"), None);
        let candidates = legacy_items(&f.library, None, None);
        assert!(doubtful.summary.doubtful.pending > 100);
        let totals = f.library.confirm_totals(None).unwrap();
        assert_eq!(totals.counts.recheck, doubtful.summary.doubtful.pending);
        let summary = f.library.character_shadow_review_summary().unwrap();
        assert_eq!(summary.automatic, candidates.summary.automatic.pending);
        assert_eq!(summary.recommended, candidates.summary.recommended.pending);
    }

    #[test]
    fn the_confirm_counts_share_the_prepared_lists_with_the_review_pages() {
        let (f, target) = summary_fixture();
        let counts = || f.library.character_confirm_counts(Some(&f.series)).unwrap();
        let page = || {
            f.library
                .character_shadow_review_page(review_query(0, 50, Some(&f.series)))
                .unwrap()
        };
        let start = prepared_lists(&f);
        assert_eq!(counts().recognition, 5);
        // The candidate and the doubtful list, one computation each.
        assert_eq!(prepared_lists(&f) - start, 2);
        // The page needs the candidate list the count just prepared.
        assert_eq!(page().items.len(), 5);
        assert_eq!(prepared_lists(&f) - start, 2);
        // A decision moves both lists' key: the count follows and prepares them again once.
        decide(&f, &target, "cached-0", DecisionKind::Rejected);
        assert_eq!(counts().recognition, 4);
        assert_eq!(prepared_lists(&f) - start, 4);
        assert_eq!(page().items.len(), 4);
        assert_eq!(prepared_lists(&f) - start, 4);
    }
