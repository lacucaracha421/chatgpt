//! Preview of the per-character 기본 인식 / 학습 인식 split on a copy of a library.
//!
//! Nothing here runs in the application. The ignored test opens copies read-only
//! (`query_only`, no migrations, no `Library`) and prints, per character, the numbers of the
//! rule and which recognition places its images before this change (the series switch in
//! `character-runtime.json`) and after it (the rule in `character_shadow_review`).
//!
//! Per character it also prints the judgments (people / automatic tags), the wrong ones, the
//! examples and the status before this change (people's judgments only) and now (the taggers'
//! agreement counted), and the 확인 totals as they stand: shown and folded away.
//!
//! ```text
//! LAKOMICS_RECOGNITION_PLAN_DB=<copy of library.sqlite> \
//! LAKOMICS_RECOGNITION_PLAN_CACHE=<copy of .cache/characters/s36_shadow.sqlite> \
//! [LAKOMICS_RECOGNITION_PLAN_RUNTIME=<copy of character-runtime.json>] \
//! bash scripts/cargo-test.sh -- --lib -- --ignored --nocapture recognition_plan_preview
//! ```
use super::character_shadow_review::{
    confirm_totals_in, is_close_to_switching, judgments_of, readiness_of, Auto,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::PathBuf, time::Instant};

fn open_read_only(path: &PathBuf) -> Connection {
    let c = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap_or_else(|e| panic!("cannot open {} read-only: {e}", path.display()));
    c.execute_batch("PRAGMA query_only=ON;").unwrap();
    c
}

/// The old per-series switch: (series that used S36, characters left out of it, where it came from).
fn old_switch() -> (BTreeSet<String>, BTreeSet<String>, String) {
    let path = std::env::var_os("LAKOMICS_RECOGNITION_PLAN_RUNTIME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("APPDATA")
                .map(|dir| PathBuf::from(dir).join("com.lakomics.desktop/character-runtime.json"))
        });
    let Some(path) = path.filter(|p| p.is_file()) else {
        return (
            BTreeSet::new(),
            BTreeSet::new(),
            "none (no runtime file found)".into(),
        );
    };
    let document: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let set = |key: &str| {
        document[key]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    (
        set("s36_series"),
        set("s36_excluded_targets"),
        path.display().to_string(),
    )
}

/// The report for open (read-only) connections to a library and its score cache.
fn plan(
    library: &Connection,
    cache: Option<&Connection>,
    series_switch: &BTreeSet<String>,
    excluded: &BTreeSet<String>,
    switch_source: &str,
) -> Value {
    let targets = library
        .prepare(
            "SELECT t.id,t.display_name,t.series_classification_id,COALESCE(e.name,''),t.enabled,t.manual_only
             FROM character_targets t LEFT JOIN classification_entries e ON e.id=t.series_classification_id
             WHERE t.role='character' ORDER BY COALESCE(e.name,''),t.display_name,t.id",
        )
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, bool>(4)?,
                r.get::<_, bool>(5)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let ids = targets.iter().map(|t| t.0.clone()).collect::<Vec<_>>();
    let started = Instant::now();
    let readiness = readiness_of(library, cache, &ids).unwrap();
    let elapsed = started.elapsed();
    // The rule before the taggers' agreement counted: people's judgments alone.
    let manual_only = judgments_of(library, cache, &ids, Auto::Off)
        .unwrap()
        .readiness;
    let confirm = confirm_totals_in(library, cache).unwrap();

    let mut rows = Vec::new();
    let mut changed = Vec::new();
    for ((target, numbers), manual) in targets.iter().zip(&readiness).zip(&manual_only) {
        let (id, name, series_id, series, enabled, manual_only) = target;
        let automatic = *enabled && !manual_only;
        let before = if !automatic {
            "manual"
        } else if series_id
            .as_ref()
            .is_some_and(|s| series_switch.contains(s))
            && !excluded.contains(id)
        {
            "S36"
        } else {
            "B36"
        };
        let after = if !automatic {
            "manual"
        } else if numbers.status == "learning" {
            "S36"
        } else {
            "B36"
        };
        let row = json!({
            "seriesId": series_id, "series": series, "targetId": id, "name": name,
            "judged": numbers.reviewed, "judgedManual": numbers.reviewed - numbers.reviewed_auto, "judgedAuto": numbers.reviewed_auto,
            "examples": numbers.examples, "wrong": numbers.wrong, "wrongManual": numbers.wrong - numbers.wrong_auto, "wrongAuto": numbers.wrong_auto,
            "allowed": numbers.allowed, "statusBefore": manual.status, "status": numbers.status,
            "closeToSwitching": is_close_to_switching(numbers.reviewed, numbers.examples),
            "before": before, "after": after,
        });
        if before != after {
            changed.push(row.clone());
        }
        rows.push(row);
    }
    let count = |engine: &str, key: &str| rows.iter().filter(|r| r[key] == engine).count();
    let status = |key: &str, value: &str| rows.iter().filter(|r| r[key] == value).count();
    let status_changed = rows
        .iter()
        .filter(|r| r["statusBefore"] != r["status"])
        .cloned()
        .collect::<Vec<_>>();
    json!({
        "oldSwitchSource": switch_source,
        "scoreCache": cache.is_some(),
        "characters": rows.len(),
        "readinessMs": elapsed.as_secs_f64() * 1000.0,
        "before": {"S36": count("S36", "before"), "B36": count("B36", "before"), "manual": count("manual", "before")},
        "after": {"S36": count("S36", "after"), "B36": count("B36", "after"), "manual": count("manual", "after")},
        "changed": changed,
        "statusBefore": {"learning": status("statusBefore", "learning"), "hold": status("statusBefore", "hold"), "collecting": status("statusBefore", "collecting")},
        "statusAfter": {"learning": status("status", "learning"), "hold": status("status", "hold"), "collecting": status("status", "collecting")},
        "statusChanged": status_changed,
        "confirm": {
            "shown": confirm.counts.recognition + confirm.counts.tag + confirm.counts.recheck,
            "recognition": confirm.counts.recognition, "tag": confirm.counts.tag, "recheck": confirm.counts.recheck,
            "foldedItems": confirm.folded_items, "foldedCharacters": confirm.folded_characters,
        },
        "rows": rows,
    })
}

#[test]
#[ignore = "needs LAKOMICS_RECOGNITION_PLAN_DB (and _CACHE) pointing at copies"]
fn recognition_plan_preview() {
    let db = PathBuf::from(
        std::env::var_os("LAKOMICS_RECOGNITION_PLAN_DB")
            .expect("set LAKOMICS_RECOGNITION_PLAN_DB to a copy of library.sqlite"),
    );
    let library = open_read_only(&db);
    let cache = std::env::var_os("LAKOMICS_RECOGNITION_PLAN_CACHE")
        .map(|path| open_read_only(&PathBuf::from(path)));
    let (series_switch, excluded, source) = old_switch();
    let report = plan(&library, cache.as_ref(), &series_switch, &excluded, &source);
    println!(
        "RECOGNITION_PLAN {}",
        serde_json::to_string_pretty(&report).unwrap()
    );
}

#[test]
fn the_plan_shows_who_changes_from_the_old_series_switch_to_the_rule() {
    use super::characters::tests::Fixture;
    let f = Fixture::new();
    let (switched, passing, manual) = (f.ready("Switched"), f.ready("Passing"), f.ready("Manual"));
    {
        let c = f.library.connection().unwrap();
        c.execute(
            "UPDATE character_targets SET manual_only=1 WHERE id=?1",
            [&manual.id],
        )
        .unwrap();
        super::character_shadow_review::seed_readiness(
            f.temp.path(),
            &c,
            &passing.id,
            "v1",
            "p",
            (29, 1, 21),
        );
    }
    let cache = open_read_only(&f.temp.path().join(".cache/characters/s36_shadow.sqlite"));
    let library = f.library.connection().unwrap();
    // The old switch covered the whole series; the rule moves only the passing character.
    let report = plan(
        &library,
        Some(&cache),
        &BTreeSet::from([f.series.clone()]),
        &BTreeSet::new(),
        "test",
    );
    let row = |id: &str| {
        report["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["targetId"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(
        (
            row(&switched.id)["before"].clone(),
            row(&switched.id)["after"].clone()
        ),
        (json!("S36"), json!("B36"))
    );
    assert_eq!(
        (
            row(&passing.id)["before"].clone(),
            row(&passing.id)["after"].clone()
        ),
        (json!("S36"), json!("S36"))
    );
    assert_eq!(
        (
            row(&manual.id)["before"].clone(),
            row(&manual.id)["after"].clone()
        ),
        (json!("manual"), json!("manual"))
    );
    let passing_row = row(&passing.id);
    assert_eq!(
        (
            &passing_row["judged"],
            &passing_row["wrong"],
            &passing_row["allowed"],
            &passing_row["examples"]
        ),
        (&json!(30), &json!(1), &json!(1), &json!(50))
    );
    assert_eq!(report["changed"].as_array().unwrap().len(), 1);
    // Nobody but people judged here, so the split is all theirs and the status did not move.
    assert_eq!(
        (
            &passing_row["judgedManual"],
            &passing_row["judgedAuto"],
            &passing_row["wrongAuto"],
            &passing_row["statusBefore"],
            &passing_row["status"]
        ),
        (
            &json!(30),
            &json!(0),
            &json!(0),
            &json!("learning"),
            &json!("learning")
        )
    );
    assert_eq!(report["statusChanged"].as_array().unwrap().len(), 0);
    assert_eq!(report["confirm"]["shown"], json!(0));
    assert_eq!(report["confirm"]["foldedItems"], json!(0));
}

#[test]
fn the_newest_policy_is_the_one_of_the_latest_score_with_or_without_the_index() {
    use super::character_shadow_review::newest_policy_for_tests as newest;
    let temp = tempfile::tempdir().unwrap();
    super::character_shadow::Cache::open(temp.path()).unwrap();
    let path = temp.path().join(".cache/characters/s36_shadow.sqlite");
    let c = Connection::open(&path).unwrap();
    let put = |asset: &str, version: &str, at: &str| {
        c.execute(
            "INSERT INTO scores(asset_id,content_hash,target_id,knn3,verdict,policy_version,feature_id,native_outcome,native_at,scored_at,prior_manual_rejections,origin)
             VALUES(?1,'h','t',0.5,'none',?2,'f','none',?3,?3,1,'live')",
            rusqlite::params![asset, version, at],
        )
        .unwrap();
    };
    assert_eq!(newest(&c), None);
    put("a", "v1", "2026-01-01T00:00:00Z");
    put("b", "v2", "2026-02-01T00:00:00Z");
    put("c", "v1", "2026-01-15T00:00:00Z");
    assert_eq!(newest(&c).as_deref(), Some("v2"));
    // The old grouped form agrees, and the index exists on a cache the application opened.
    let grouped: String = c
        .query_row("SELECT policy_version FROM scores GROUP BY policy_version ORDER BY MAX(scored_at) DESC, policy_version DESC LIMIT 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(grouped, "v2");
    let index: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='scores_by_time'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(index, 1);
    c.execute("DROP INDEX scores_by_time", []).unwrap();
    assert_eq!(newest(&c).as_deref(), Some("v2"));
    // A tie in time goes to the greater version, as before.
    put("d", "v3", "2026-02-01T00:00:00Z");
    assert_eq!(newest(&c).as_deref(), Some("v3"));
}
