//! Candidate feed export (parity with the desktop S36 review, S36 series rule, merge, basis,
//! committed-only) and its durable, throttled publication.
use std::collections::BTreeSet;

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use super::*;
use crate::library::character_shadow_review::ShadowReviewQuery;
use crate::library::characters::tests::Fixture;
use crate::library::characters::{DecisionKind, DecisionRequest, Target};
use crate::library::collection_personal_edits::tests::{configure, scripted};

fn hash(id: &str) -> String {
    Sha256::digest(id.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn series_asset(f: &Fixture, id: &str, committed: bool) {
    let original = format!("assets/{id}.png");
    let thumbnail = format!("thumbnails/{id}.webp");
    std::fs::write(f.temp.path().join(&original), id.as_bytes()).unwrap();
    std::fs::write(f.temp.path().join(&thumbnail), id.as_bytes()).unwrap();
    let c = f.library.connection().unwrap();
    c.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
        VALUES(?1,?2,'image',?1,?3,?4,7,3,2,'2026-09-08','normal')", params![id, hash(id), original, thumbnail]).unwrap();
    c.execute(
        "INSERT INTO asset_classifications VALUES(?1,?2)",
        params![id, f.series],
    )
    .unwrap();
    drop(c);
    if committed {
        commit(f, id);
    }
}

/// Mark an asset as a committed cloud upload.
fn commit(f: &Fixture, id: &str) {
    f.library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO cloud_sync_queue(id,entity_type,entity_id,operation,status,revision,updated_at,synced_at)
             VALUES(?1,'asset',?2,'upsert','synced',1,'2026','2026')",
            params![format!("queue-{id}"), id],
        )
        .unwrap();
}

fn scores(f: &Fixture, rows: &[(&str, &str, &str, f64)]) {
    crate::library::character_shadow::Cache::open(f.temp.path()).unwrap();
    let c = Connection::open(f.temp.path().join(".cache/characters/s36_shadow.sqlite")).unwrap();
    for (asset, target, verdict, knn3) in rows {
        c.execute(
            "INSERT OR REPLACE INTO scores(asset_id,content_hash,target_id,knn3,verdict,policy_version,feature_id,native_outcome,native_at,scored_at,prior_manual_rejections)
             VALUES(?1,?2,?3,?4,?5,'s36-v3','feature','none','2026-09-23T01:00:00Z','2026-09-23T01:00:00Z',100)",
            params![asset, hash(asset), target, knn3, verdict],
        )
        .unwrap();
    }
}

fn b36(f: &Fixture, target: &Target, asset: &str) {
    let c = f.library.connection().unwrap();
    let path: String = c
        .query_row(
            "SELECT relative_path FROM assets WHERE id=?1",
            [asset],
            |r| r.get(0),
        )
        .unwrap();
    let evidence = format!("evidence-{asset}");
    c.execute(
        "INSERT INTO character_autotag_jobs(asset_id,generation,source_generation,content_hash,relative_path,classification_ids,state,review_state,priority,cause,updated_at) VALUES(?1,1,1,?2,?3,?4,'completed','unresolved',1,'ingestion','now')",
        params![asset, hash(asset), path, serde_json::to_string(&vec![&f.series]).unwrap()],
    ).unwrap();
    c.execute(
        "INSERT INTO character_autotag_evidence(id,asset_id,generation,source_generation,content_hash,context_hash,runtime_fingerprint,scope_json,unresolved_regions,created_at) VALUES(?1,?2,1,1,?3,'context','runtime','{}','[]','now')",
        params![evidence, asset, hash(asset)],
    ).unwrap();
    c.execute(
        "INSERT INTO character_autotag_predictions(evidence_id,target_id,series_id,target_fingerprint,result_json) VALUES(?1,?2,?3,?4,?5)",
        params![evidence, target.id, f.series, target.fingerprint, serde_json::json!({
            "assetId": asset, "contentHash": hash(asset), "state": "recommended", "evidence": null, "error": null
        }).to_string()],
    ).unwrap();
}

fn automatic_acceptance(f: &Fixture, target: &Target, asset: &str) -> i64 {
    let c = f.library.connection().unwrap();
    c.execute(
        "INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
         VALUES(?1,?2,?2,?3,'accepted',?4,'{}','automatic','2026-09-20T00:00:00Z')",
        params![target.id, asset, hash(asset), target.fingerprint],
    )
    .unwrap();
    c.last_insert_rowid()
}

fn pairs(content: &FeedContent) -> Vec<(String, Vec<&'static str>, String)> {
    content
        .items
        .iter()
        .map(|i| (i.asset_id.clone(), i.sources.clone(), i.verdict.clone()))
        .collect()
}

#[test]
fn s36_candidates_match_the_desktop_review_list_and_its_pages() {
    let f = Fixture::new();
    let target = f.ready("Shadow");
    let ids: Vec<String> = (8..16).map(|i| format!("asset-{i}")).collect();
    for id in &ids {
        series_asset(&f, id, true);
    }
    let rows: Vec<_> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| {
            (
                id.as_str(),
                target.id.as_str(),
                if i < 5 { "automatic" } else { "recommended" },
                i as f64 / 10.0,
            )
        })
        .collect();
    scores(&f, &rows);
    // The page command is a slice of the full list, page by page.
    let all = f.library.shadow_review_items(None).unwrap();
    assert_eq!(all.items.len(), 8);
    let mut paged = Vec::new();
    let mut offset = 0;
    loop {
        let page = f
            .library
            .character_shadow_review_page(ShadowReviewQuery {
                offset,
                limit: 3,
                mode: None,
            })
            .unwrap();
        assert_eq!(page.summary, all.summary);
        paged.extend(page.items);
        match page.next_offset {
            Some(next) => offset = next,
            None => break,
        }
    }
    assert_eq!(paged, all.items);
    // Outside an S36 series the feed offers exactly that list, in the same order.
    let feed = f
        .library
        .character_review_feed_content(Some(&BTreeSet::new()))
        .unwrap();
    let expected: Vec<_> = all
        .items
        .iter()
        .map(|i| (i.asset_id.clone(), vec!["s36"], i.verdict.clone()))
        .collect();
    assert_eq!(pairs(&feed), expected);
    assert_eq!(feed.items[0].knn3, all.items[0].knn3);
    assert_eq!(feed.policy_version, "s36-v3");
    let described = &feed.targets[&target.id];
    assert_eq!(described.fingerprint, target.fingerprint);
    assert_eq!(described.series_id, f.series);
    assert!(
        described.reference_asset_ids.is_empty(),
        "uncommitted references are not listed"
    );
}

#[test]
fn an_s36_series_offers_no_automatic_acceptances() {
    let f = Fixture::new();
    let target = f.ready("Shadow");
    for id in ["asset-8", "asset-9"] {
        series_asset(&f, id, true);
    }
    scores(
        &f,
        &[
            ("asset-8", &target.id, "automatic", 0.1),
            ("asset-9", &target.id, "recommended", 0.2),
        ],
    );
    let switched = BTreeSet::from([f.series.clone()]);
    let feed = f
        .library
        .character_review_feed_content(Some(&switched))
        .unwrap();
    assert_eq!(
        pairs(&feed),
        [(
            "asset-9".to_string(),
            vec!["s36"],
            "recommended".to_string()
        )]
    );
    // Unknown switch (automation not configured yet): automatic verdicts stay out.
    let unknown = f.library.character_review_feed_content(None).unwrap();
    assert_eq!(pairs(&unknown), pairs(&feed));
    let other = BTreeSet::from(["another-series".to_string()]);
    assert_eq!(
        f.library
            .character_review_feed_content(Some(&other))
            .unwrap()
            .items
            .len(),
        2
    );
}

#[test]
fn sources_merge_per_pair_with_basis_and_only_committed_assets() {
    let f = Fixture::new();
    let target = f.ready("Shadow");
    for id in ["asset-8", "asset-9", "asset-10"] {
        series_asset(&f, id, true);
    }
    series_asset(&f, "asset-11", false);
    // asset-8: an automatic acceptance S36 only recommends → s36 + doubtful.
    let accepted = automatic_acceptance(&f, &target, "asset-8");
    scores(
        &f,
        &[
            ("asset-8", &target.id, "recommended", 0.3),
            ("asset-9", &target.id, "recommended", 0.2),
            ("asset-11", &target.id, "recommended", 0.1),
        ],
    );
    // asset-9 also has a saved B36 recommendation; asset-10 only that.
    b36(&f, &target, "asset-9");
    b36(&f, &target, "asset-10");
    for id in ["asset-0", "asset-1"] {
        commit(&f, id);
    }
    let feed = f
        .library
        .character_review_feed_content(Some(&BTreeSet::new()))
        .unwrap();
    let mut got = pairs(&feed);
    got.sort();
    assert_eq!(
        got,
        [
            (
                "asset-10".to_string(),
                vec!["b36"],
                "recommended".to_string()
            ),
            (
                "asset-8".to_string(),
                vec!["s36", "doubtful"],
                "recommended".to_string()
            ),
            (
                "asset-9".to_string(),
                vec!["s36", "b36"],
                "recommended".to_string()
            ),
        ]
    );
    let basis = |asset: &str| {
        feed.items
            .iter()
            .find(|i| i.asset_id == asset)
            .unwrap()
            .basis
            .clone()
    };
    assert_eq!(basis("asset-8"), accepted.to_string());
    assert_eq!(basis("asset-9"), "0");
    assert_eq!(
        feed.targets[&target.id].reference_asset_ids,
        ["asset-0", "asset-1"]
    );
    // Same B36 rows as the per-target desktop "recommended" page.
    let page = f
        .library
        .character_review_page(crate::library::character_scan::ReviewQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id.clone()),
            filter: "recommended".into(),
            after: None,
            limit: 80,
        })
        .unwrap();
    let mut desktop: Vec<String> = page.rows.iter().map(|r| r.asset.id.clone()).collect();
    desktop.sort();
    assert_eq!(desktop, ["asset-10", "asset-9"]);
    // A decided pair leaves the feed.
    f.library
        .record_character_decisions(DecisionRequest {
            target_id: target.id.clone(),
            expected_fingerprint: target.fingerprint.clone(),
            asset_ids: vec!["asset-10".into()],
            decision: DecisionKind::Rejected,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
    let feed = f
        .library
        .character_review_feed_content(Some(&BTreeSet::new()))
        .unwrap();
    assert!(feed.items.iter().all(|i| i.asset_id != "asset-10"));
}

#[test]
fn the_published_body_has_the_shared_fixture_shape() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../tests/fixtures/mobile-character-review-feed.json"
    ))
    .unwrap();
    let targets = BTreeMap::from([(
        "c".to_string(),
        FeedTarget {
            name: "캐릭터".into(),
            series_id: "s".into(),
            fingerprint: "fp-c-1".into(),
            reference_asset_ids: vec!["ref-1".into()],
        },
    )]);
    let items = [FeedItem {
        asset_id: "a".into(),
        target_id: "c".into(),
        sources: vec!["s36", "b36"],
        verdict: "recommended".into(),
        knn3: Some(0.5),
        basis: "12".into(),
    }];
    let body = serde_json::to_value(FeedBody {
        version: 1,
        library_id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        base_revision: None,
        decision_cursor: 0,
        policy_version: "s36-v3",
        generated_at: "2026-09-24T09:00:00Z",
        skipped: &[FeedSkipped {
            sequence: 1,
            reason: "targetMissing".into(),
        }],
        targets: &targets,
        items: &items,
    })
    .unwrap();
    let keys = |value: &serde_json::Value| {
        value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>()
    };
    assert_eq!(keys(&body), keys(&fixture));
    assert_eq!(keys(&body["targets"]["c"]), keys(&fixture["targets"]["c"]));
    assert_eq!(keys(&body["items"][0]), keys(&fixture["items"][1]));
    assert_eq!(
        body["skipped"][0],
        serde_json::json!({"sequence": 1, "reason": "targetMissing"})
    );
    // Every fixture item validates against the PC's own id/token rules.
    for item in fixture["items"].as_array().unwrap() {
        assert!(valid_id(item["assetId"].as_str().unwrap()));
        assert!(valid_token(item["basis"].as_str().unwrap()));
    }
}

// --- Scripted server: durable, throttled publication -----------------------------------

fn receipt(revision: char) -> String {
    format!(
        r#"{{"version":1,"revision":"{}","items":0,"dropped":0}}"#,
        revision.to_string().repeat(64)
    )
}

/// Adopt manual exclusions and the review channel on `base`, as a prior publication would.
fn bind(f: &Fixture, base: &str) -> String {
    configure(&f.library, base);
    let id = f.library.library_id().unwrap();
    f.library
        .adopt_character_exclusion_library(base, &id)
        .unwrap();
    f.library.adopt_character_review_library(base, &id).unwrap();
    id
}

fn state(f: &Fixture, sql: &str) {
    f.library.connection().unwrap().execute(sql, []).unwrap();
}

#[test]
fn feed_publication_is_debounced_throttled_and_skips_an_unchanged_body() {
    let f = Fixture::new();
    let target = f.ready("Shadow");
    series_asset(&f, "asset-8", true);
    scores(&f, &[("asset-8", &target.id, "recommended", 0.3)]);
    let (base, handle) = scripted(vec![
        ("/v1/library/characters/review/feed", 200, receipt('a')),
        ("/v1/library/characters/review/feed", 200, receipt('b')),
    ]);
    let id = bind(&f, &base);
    let client = CloudClient::new(&base).unwrap();
    let series = BTreeSet::new();
    let publish = || {
        f.library
            .publish_due_character_review_feed_with(
                &client,
                "publisher",
                "shared",
                &base,
                Some(&series),
            )
            .unwrap()
    };
    // First: adoption PUT.
    assert_eq!(
        publish(),
        FeedOutcome::Published {
            revision: "a".repeat(64)
        }
    );
    // Nothing changed: not due.
    assert_eq!(publish(), FeedOutcome::NotDue);
    // Five minutes later the feed is rebuilt, but an identical body is not sent again.
    state(
        &f,
        "UPDATE mobile_character_review_feed_state SET built_at=unixepoch()-301",
    );
    assert_eq!(publish(), FeedOutcome::Unchanged);
    // A decision changes the inputs: debounced for 30 seconds ...
    f.library
        .record_character_decisions(DecisionRequest {
            target_id: target.id.clone(),
            expected_fingerprint: target.fingerprint.clone(),
            asset_ids: vec!["asset-8".into()],
            decision: DecisionKind::Accepted,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
    assert_eq!(publish(), FeedOutcome::NotDue);
    // ... then published sooner than the five-minute refresh, naming the previous revision.
    state(
        &f,
        "UPDATE mobile_character_review_feed_state SET last_dirty=unixepoch()-31",
    );
    assert_eq!(
        publish(),
        FeedOutcome::Published {
            revision: "b".repeat(64)
        }
    );
    let seen = handle.join().unwrap();
    assert_eq!(seen.len(), 2);
    let first: serde_json::Value = serde_json::from_str(&seen[0].2).unwrap();
    let second: serde_json::Value = serde_json::from_str(&seen[1].2).unwrap();
    assert_eq!(first["baseRevision"], serde_json::Value::Null);
    assert_eq!(first["libraryId"], id);
    assert_eq!(first["items"][0]["assetId"], "asset-8");
    assert_eq!(second["baseRevision"], "a".repeat(64));
    assert!(
        second["items"].as_array().unwrap().is_empty(),
        "the decided pair left the feed"
    );
    // The throttle survives a restart: the state is durable.
    let dirty: bool = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT published_input_digest IS input_digest FROM mobile_character_review_feed_state",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(dirty);
}

#[test]
fn skipped_decisions_are_reported_once_with_the_acknowledged_cursor() {
    let f = Fixture::new();
    f.ready("Shadow");
    let (base, handle) = scripted(vec![
        ("/v1/library/characters/review/feed", 200, receipt('a')),
        ("/v1/library/characters/review/feed", 200, receipt('b')),
    ]);
    let id = bind(&f, &base);
    let skip = crate::library::character_review_sync::ReviewDecisionEntry {
        sequence: 1,
        operation_id: "op-1".into(),
        target_id: "missing".into(),
        asset_id: "asset-5".into(),
        decision: "accepted".into(),
        origin: "feed".into(),
        basis: Some("0".into()),
        asset_sha256: hash("asset-5"),
        created_at: "now".into(),
    };
    f.library
        .apply_character_review_page(&base, &id, &[skip])
        .unwrap();
    let client = CloudClient::new(&base).unwrap();
    let publish = || {
        f.library
            .publish_due_character_review_feed_with(
                &client,
                "publisher",
                "shared",
                &base,
                Some(&BTreeSet::new()),
            )
            .unwrap()
    };
    // Received but not yet acknowledged by a snapshot: the feed does not claim it.
    assert!(matches!(publish(), FeedOutcome::Published { .. }));
    f.library
        .acknowledge_character_review_publication(&base, &id, 1)
        .unwrap();
    // The acknowledged position changes the inputs (debounced like any other change).
    assert_eq!(publish(), FeedOutcome::NotDue);
    state(
        &f,
        "UPDATE mobile_character_review_feed_state SET last_dirty=unixepoch()-31",
    );
    assert!(matches!(publish(), FeedOutcome::Published { .. }));
    let seen = handle.join().unwrap();
    let first: serde_json::Value = serde_json::from_str(&seen[0].2).unwrap();
    let second: serde_json::Value = serde_json::from_str(&seen[1].2).unwrap();
    assert_eq!(
        (first["decisionCursor"].clone(), first["skipped"].clone()),
        (0.into(), serde_json::json!([]))
    );
    assert_eq!(second["decisionCursor"], 1);
    assert_eq!(
        second["skipped"],
        serde_json::json!([{"sequence": 1, "reason": "targetMissing"}])
    );
}

#[test]
fn an_older_server_or_a_stale_base_never_breaks_the_feed() {
    let f = Fixture::new();
    f.ready("Shadow");
    let changed = r#"{"detail":{"code":"characterReviewFeedChanged","message":"x"}}"#;
    let (base, handle) = scripted(vec![
        // No route: an older server.
        ("/v1/library/characters/review/feed", 404, String::new()),
        // Later: a stale base is re-read through the mobile route and retried once.
        ("/v1/library/characters/review/feed", 409, changed.into()),
        (
            "/v1/library/characters/review?limit=1",
            200,
            format!(r#"{{"version":1,"revision":"{}"}}"#, "c".repeat(64)),
        ),
        ("/v1/library/characters/review/feed", 200, receipt('d')),
    ]);
    bind(&f, &base);
    let client = CloudClient::new(&base).unwrap();
    let publish = || {
        f.library
            .publish_due_character_review_feed_with(
                &client,
                "publisher",
                "shared",
                &base,
                Some(&BTreeSet::new()),
            )
            .unwrap()
    };
    assert_eq!(publish(), FeedOutcome::Unsupported);
    assert_eq!(
        publish(),
        FeedOutcome::NotDue,
        "retried only after five minutes"
    );
    state(
        &f,
        "UPDATE mobile_character_review_feed_state SET retry_after=0",
    );
    assert_eq!(
        publish(),
        FeedOutcome::Published {
            revision: "d".repeat(64)
        }
    );
    let seen = handle.join().unwrap();
    assert_eq!(seen[2].1.as_deref(), Some("Bearer shared"));
    let retried: serde_json::Value = serde_json::from_str(&seen[3].2).unwrap();
    assert_eq!(retried["baseRevision"], "c".repeat(64));
    // Without adopted manual exclusions there is nothing to publish and no request.
    let g = Fixture::new();
    configure(&g.library, &base);
    assert_eq!(
        g.library
            .publish_due_character_review_feed_with(&client, "publisher", "shared", &base, None)
            .unwrap(),
        FeedOutcome::NotReady
    );
}
