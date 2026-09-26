use super::*;
use crate::library::characters::tests::Fixture;
use rusqlite::types::Value as SqlValue;

type Rows = Vec<Vec<SqlValue>>;

/// [`REVIEW_INPUT_SQL`] before PERF-ALL-001.
const PRE_FIX_INPUT_SQL: &str = "WITH RECURSIVE scope(id) AS (
    SELECT id FROM classification_entries WHERE id=?1 UNION
    SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id),
    ancestors(id,parent_id) AS (SELECT id,parent_id FROM classification_entries WHERE id=?1 UNION ALL
    SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id)
    SELECT a.id,a.content_hash,a.relative_path FROM assets a
    WHERE a.status='normal' AND a.media_kind='image' AND a.id > COALESCE(?2, '')
    AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND (
        ac.classification_id IN (SELECT id FROM scope) OR (
        ac.classification_id IN (SELECT id FROM ancestors) AND (
            a.id IN (SELECT value FROM json_each(?3)) OR
            EXISTS(SELECT 1 FROM character_autotag_evidence e
                JOIN character_autotag_predictions p ON p.evidence_id=e.id
                JOIN character_autotag_jobs j ON j.asset_id=e.asset_id AND j.source_generation=e.source_generation
                WHERE e.asset_id=a.id AND p.series_id=?1 AND j.state<>'superseded') OR
            EXISTS(SELECT 1 FROM character_autotag_jobs j WHERE j.asset_id=a.id AND j.state='failed')))))
    ORDER BY a.id LIMIT ?4";

/// [`REVIEW_BATCH_DURABLE_SQL`] before PERF-ALL-001 (every generation; the caller kept the
/// first row per (asset, target)).
const PRE_FIX_DURABLE_SQL: &str = "SELECT e.id,e.asset_id,p.target_id,p.result_json,p.target_fingerprint,e.runtime_fingerprint
    FROM character_autotag_evidence e
    JOIN character_autotag_predictions p ON p.evidence_id=e.id
    JOIN character_autotag_jobs j ON j.asset_id=e.asset_id AND j.source_generation=e.source_generation
    JOIN assets a ON a.id=e.asset_id AND a.content_hash=e.content_hash AND a.status='normal'
    WHERE e.asset_id IN (SELECT value FROM json_each(?2)) AND p.series_id=?1 AND j.state<>'superseded'
    AND (?3 IS NULL OR p.target_id=?3)
    ORDER BY e.asset_id,p.target_id,e.generation DESC,e.id DESC";

/// Every column of every row, and the statement's VM steps.
fn run(
    connection: &rusqlite::Connection,
    sql: &str,
    values: &[&dyn rusqlite::ToSql],
) -> (Rows, i32) {
    let mut statement = connection.prepare(sql).unwrap();
    let columns = statement.column_count();
    let rows = statement
        .query_map(values, |row| {
            (0..columns)
                .map(|index| row.get::<_, SqlValue>(index))
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    (
        rows,
        statement.get_status(rusqlite::StatementStatus::VmStep),
    )
}

/// The rows the review page used from the pre-fix statement: the first per (asset, target).
fn first_per_pair(rows: Rows) -> Rows {
    let mut seen = std::collections::BTreeSet::new();
    rows.into_iter()
        .filter(|row| seen.insert(format!("{:?}\u{0}{:?}", row[1], row[2])))
        .collect()
}

#[derive(Default)]
struct Totals {
    inputs: usize,
    durable_rows: usize,
    input_fixed: i64,
    input_plain: i64,
    durable_fixed: i64,
    durable_plain: i64,
}

/// Pages through a series like `character_review_page_mode` (no scan memory) with the
/// product and pre-fix statements, asserting identical rows; sums VM steps.
fn compare_series(
    connection: &rusqlite::Connection,
    series_id: &str,
    target_ids: &[Option<String>],
    totals: &mut Totals,
) {
    let mut after: Option<String> = None;
    loop {
        let values = params![series_id, after, "[]", 256];
        let (fixed, fixed_steps) = run(connection, REVIEW_INPUT_SQL, values);
        let (plain, plain_steps) = run(connection, PRE_FIX_INPUT_SQL, values);
        assert_eq!(fixed, plain, "series {series_id} after {after:?}");
        totals.inputs += fixed.len();
        totals.input_fixed += i64::from(fixed_steps);
        totals.input_plain += i64::from(plain_steps);
        let ids = fixed
            .iter()
            .map(|row| match &row[0] {
                SqlValue::Text(id) => id.clone(),
                other => panic!("unexpected id {other:?}"),
            })
            .collect::<Vec<_>>();
        let encoded = serde_json::to_string(&ids).unwrap();
        for target_id in target_ids {
            let values = params![series_id, encoded, target_id];
            let (fixed, fixed_steps) = run(connection, REVIEW_BATCH_DURABLE_SQL, values);
            let (plain, plain_steps) = run(connection, PRE_FIX_DURABLE_SQL, values);
            assert_eq!(
                fixed,
                first_per_pair(plain),
                "series {series_id} target {target_id:?} after {after:?}"
            );
            totals.durable_rows += fixed.len();
            totals.durable_fixed += i64::from(fixed_steps);
            totals.durable_plain += i64::from(plain_steps);
        }
        if ids.len() < 256 {
            break;
        }
        after = ids.last().cloned();
    }
}

/// PERF-ALL-001 tighten-only gate. One review-page batch must cost VM steps in proportion
/// to the batch, not to every normal asset or every prediction of the series. The pre-fix
/// statements run on the same fixture to prove identical rows and that the thresholds catch
/// the regression. Lower a `MAX_*` after a verified improvement; raise it only with a
/// justified, measured reason.
#[test]
fn review_page_vm_steps_stay_bounded_by_the_batch() {
    const IN_SCOPE: usize = 1_200;
    // Measured on this fixture (bundled SQLite of rusqlite 0.40), first batch series-wide:
    // input fixed 11,968, pre-fix 14,458,279; durable fixed 48,445, pre-fix 101,791.
    const MAX_INPUT_VM_STEPS: i32 = 15_000;
    const MAX_DURABLE_VM_STEPS: i32 = 60_000;

    let f = Fixture::new();
    let a = f.ready("A");
    let b = f.ready("B");
    {
        let mut connection = f.library.connection().unwrap();
        let root: String = connection
            .query_row(
                "SELECT parent_id FROM classification_entries WHERE id=?1",
                [&f.series],
                |row| row.get(0),
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        {
            let mut asset = transaction
                .prepare(
                    "INSERT INTO assets (
                        id, content_hash, media_kind, original_name, relative_path,
                        thumbnail_relative_path, byte_size, width, height, collected_at, status
                     ) VALUES (?1, 'hash-' || ?1, 'image', ?1 || '.png', 'assets/' || ?1 || '.png',
                        'thumbnails/' || ?1 || '.webp', 1, 1, 1, '2026-09-26T00:00:00Z', 'normal')",
                )
                .unwrap();
            let mut link = transaction
                .prepare("INSERT INTO asset_classifications VALUES (?1, ?2)")
                .unwrap();
            let mut job = transaction
                .prepare(
                    "INSERT INTO character_autotag_jobs (
                        asset_id, generation, source_generation, content_hash, relative_path,
                        classification_ids, state, review_state, updated_at
                     ) VALUES (?1, 2, 1, 'hash-' || ?1, 'assets/' || ?1 || '.png', '[]',
                        'completed', 'resolved', '2026-09-26T00:00:00Z')",
                )
                .unwrap();
            let mut evidence = transaction
                .prepare(
                    "INSERT INTO character_autotag_evidence (
                        id, asset_id, generation, source_generation, content_hash, context_hash,
                        runtime_fingerprint, scope_json, unresolved_regions, created_at
                     ) VALUES (?1 || '-' || ?2, ?1, ?2, 1, 'hash-' || ?1, 'context', 'runtime',
                        '[]', '[]', '2026-09-26T00:00:00Z')",
                )
                .unwrap();
            let mut prediction = transaction
                .prepare(
                    "INSERT INTO character_autotag_predictions VALUES (
                        ?1 || '-' || ?2, ?3, ?4, 'fingerprint', json_object('state', ?5))",
                )
                .unwrap();
            for index in 0..IN_SCOPE {
                let id = format!("rv-s-{index:05}");
                asset.execute([&id]).unwrap();
                link.execute(params![id, f.child]).unwrap();
                job.execute([&id]).unwrap();
                for generation in 1..=2 {
                    evidence.execute(params![id, generation]).unwrap();
                    for target in [&a, &b] {
                        // The newest generation lacks B for a quarter of the assets, so the
                        // older B row must survive the per-pair deduplication.
                        if generation == 2 && target.id == b.id && index % 4 == 0 {
                            continue;
                        }
                        let state = if generation == 2 {
                            "recommended"
                        } else {
                            "unmatched"
                        };
                        prediction
                            .execute(params![id, generation, target.id, f.series, state])
                            .unwrap();
                    }
                }
                // Every third one has a parent-folder neighbour with its own job and evidence
                // but no prediction in this series: not a candidate, yet the pre-fix plan
                // scanned every prediction of the series to find that out.
                if index % 3 == 0 {
                    let id = format!("rv-s-{index:05}-p");
                    asset.execute([&id]).unwrap();
                    link.execute(params![id, root]).unwrap();
                    job.execute([&id]).unwrap();
                    evidence.execute(params![id, 1]).unwrap();
                }
            }
        }
        transaction.commit().unwrap();
    }

    let connection = f.library.connection().unwrap();
    let values = params![f.series, None::<String>, "[]", 256];
    let (fixed, input_fixed) = run(&connection, REVIEW_INPUT_SQL, values);
    let (plain, input_plain) = run(&connection, PRE_FIX_INPUT_SQL, values);
    assert_eq!(fixed, plain);
    assert_eq!(fixed.len(), 256);
    let ids = fixed.iter().map(|row| row[0].clone()).collect::<Vec<_>>();
    let encoded = serde_json::to_string(
        &ids.iter()
            .map(|id| match id {
                SqlValue::Text(id) => id.as_str(),
                other => panic!("unexpected id {other:?}"),
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let values = params![f.series, encoded, None::<String>];
    let (fixed, durable_fixed) = run(&connection, REVIEW_BATCH_DURABLE_SQL, values);
    let (plain, durable_plain) = run(&connection, PRE_FIX_DURABLE_SQL, values);
    let used = first_per_pair(plain.clone());
    assert!(used.len() < plain.len());
    assert_eq!(fixed, used);

    let mut totals = Totals::default();
    compare_series(
        &connection,
        &f.series,
        &[None, Some(a.id.clone()), Some(b.id.clone())],
        &mut totals,
    );
    assert_eq!(totals.inputs, 6 + IN_SCOPE);
    drop(connection);
    eprintln!(
        "input VM steps: fixed {input_fixed}, pre-fix {input_plain}; durable VM steps: fixed {durable_fixed}, pre-fix {durable_plain}"
    );

    assert!(
        input_fixed <= MAX_INPUT_VM_STEPS,
        "input VM steps {input_fixed} exceed the gate {MAX_INPUT_VM_STEPS}"
    );
    assert!(
        input_plain > MAX_INPUT_VM_STEPS,
        "the pre-fix input plan ({input_plain} VM steps) no longer exceeds the gate"
    );
    assert!(
        durable_fixed <= MAX_DURABLE_VM_STEPS,
        "durable VM steps {durable_fixed} exceed the gate {MAX_DURABLE_VM_STEPS}"
    );
    assert!(
        durable_plain > MAX_DURABLE_VM_STEPS,
        "the pre-fix durable plan ({durable_plain} VM steps) no longer exceeds the gate"
    );
}

/// Real-data equality check for the review-page rewrites: every series with characters,
/// paged like the review page, series-wide and per character. Point
/// `LAKOMICS_CHARACTERS_SNAPSHOT_DB` at the `library.sqlite` of a snapshot copy, never at the
/// live library; it is opened read-only.
#[test]
#[ignore = "needs LAKOMICS_CHARACTERS_SNAPSHOT_DB"]
fn review_page_statements_match_pre_fix_plan_on_snapshot() {
    let path = std::env::var_os("LAKOMICS_CHARACTERS_SNAPSHOT_DB")
        .expect("LAKOMICS_CHARACTERS_SNAPSHOT_DB");
    let connection =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let series = connection
        .prepare("SELECT DISTINCT series_classification_id FROM character_targets WHERE series_classification_id IS NOT NULL ORDER BY 1")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let mut totals = Totals::default();
    for series_id in &series {
        let mut target_ids = vec![None];
        target_ids.extend(
            connection
                .prepare("SELECT id FROM character_targets WHERE series_classification_id=?1 ORDER BY id")
                .unwrap()
                .query_map([series_id], |row| row.get::<_, String>(0).map(Some))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap(),
        );
        compare_series(&connection, series_id, &target_ids, &mut totals);
    }
    eprintln!(
        "{} series, {} inputs, {} durable rows; input VM steps: fixed {}, pre-fix {}; durable VM steps: fixed {}, pre-fix {}",
        series.len(),
        totals.inputs,
        totals.durable_rows,
        totals.input_fixed,
        totals.input_plain,
        totals.durable_fixed,
        totals.durable_plain
    );
}
