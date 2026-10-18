use super::*;
use crate::library::{character_shadow::Cache, characters::tests::Fixture};
use std::sync::Mutex;

struct Fake {
    calls: Mutex<Vec<String>>,
    answers: Mutex<VecDeque<Value>>,
}
impl Fake {
    fn new(answers: Vec<Value>) -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            answers: Mutex::new(answers.into()),
        }
    }
}
impl Transport for Fake {
    fn post(&self, key: &str, body: &[u8]) -> std::result::Result<Reply, ()> {
        assert_eq!(key, "test-key");
        let body: Value = serde_json::from_slice(body).unwrap();
        self.calls
            .lock()
            .unwrap()
            .push(body["model"].as_str().unwrap().into());
        let answer = self
            .answers
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected extra request");
        Ok(Reply {status:200,retry_after:None,body:json!({"stop_reason":"end_turn","content":[{"type":"text","text":answer.to_string()}],"usage":{"input_tokens":1000,"output_tokens":100,"cache_creation_input_tokens":3000,"cache_read_input_tokens":500}}).to_string()})
    }
}
fn yes(confidence: f64) -> Value {
    json!({"present":[{"label":"A","confidence":confidence}],"none":false})
}
fn none() -> Value {
    json!({"present":[],"none":true})
}
fn fixture(n: usize) -> Fixture {
    let f = Fixture::new();
    for i in 0..7 {
        let path = f.temp.path().join(format!("assets/asset-{i}.png"));
        image::RgbImage::from_pixel(8, 6, image::Rgb([i as u8 * 30, 100, 150]))
            .save(&path)
            .unwrap();
        let hash = Sha256::digest(std::fs::read(path).unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET content_hash=?2,width=8,height=6 WHERE id=?1",
                params![format!("asset-{i}"), hash],
            )
            .unwrap();
    }
    let targets = (0..n)
        .map(|i| f.ready_in_series(&format!("Member {i}"), &f.series))
        .collect::<Vec<_>>();
    if n > 5 {
        Cache::open(f.temp.path()).unwrap();
        let cache =
            Connection::open(f.temp.path().join(".cache/characters/s36_shadow.sqlite")).unwrap();
        let hash: String = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT content_hash FROM assets WHERE id='asset-5'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        for (i, t) in targets.iter().enumerate() {
            cache.execute("INSERT INTO scores(asset_id,content_hash,target_id,knn3,verdict,policy_version,feature_id,native_outcome,native_at,scored_at,prior_manual_rejections) VALUES('asset-5',?1,?2,?3,'none','v1','feature','none','now','now',0)",params![hash,t.id,i as f64/100.0]).unwrap();
        }
    }
    let c = f.library.connection().unwrap();
    c.execute(
        "INSERT OR IGNORE INTO character_series(classification_id) VALUES(?1)",
        [&f.series],
    )
    .unwrap();
    c.execute("UPDATE character_autotag_jobs SET state='superseded'", [])
        .unwrap();
    c.execute("DELETE FROM character_reference_refreshes", [])
        .unwrap();
    c.execute(
        "UPDATE character_autotag_control SET paused=0,reference_refresh_paused=0",
        [],
    )
    .unwrap();
    drop(c);
    f
}
fn start(f: &Fixture) {
    let first = f.library.member_plan().unwrap();
    assert_eq!(first.total, 1);
    // Closing and reopening the confirmation must preserve its eligible cohort.
    let plan = f.library.member_plan().unwrap();
    assert_eq!(plan.total, 1);
    f.library
        .member_control("start", None, plan.plan_id.as_deref(), None)
        .unwrap();
}
fn tick(l: &Library, fake: &Fake) -> bool {
    l.member_turn(&AtomicBool::new(false), fake, &|| Some("test-key".into()))
        .unwrap()
}
fn decision_count(l: &Library) -> i64 {
    l.connection()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM character_decisions", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn member_run_accepts_only_small_series_at_point_nine() {
    for (n, confidence, accepted) in [(2, 0.9, true), (5, 0.99, true), (5, 0.899, false)] {
        let f = fixture(n);
        start(&f);
        let fake = Fake::new(vec![yes(confidence)]);
        assert!(tick(&f.library, &fake));
        assert_eq!(fake.calls.lock().unwrap().as_slice(), [SONNET]);
        assert_eq!(decision_count(&f.library), i64::from(accepted));
        // Below the bar the label goes to the confirmation queue instead of being dropped.
        assert_eq!(
            f.library.member_recommendations().unwrap().len(),
            usize::from(!accepted)
        );
        let c = f.library.connection().unwrap();
        let non_auto: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM character_decisions WHERE origin<>'automatic'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(non_auto, 0);
        let learned: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM character_learned_references",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(learned, 0);
    }
}
#[test]
fn member_run_large_series_recommends_and_cascades_only_on_empty() {
    for (n, answers, models) in [
        (6, vec![yes(0.95)], vec![HAIKU]),
        (16, vec![none(), yes(0.99)], vec![HAIKU, SONNET]),
    ] {
        let f = fixture(n);
        start(&f);
        let fake = Fake::new(answers);
        assert_eq!(
            f.library
                .character_confirm_counts(Some(&f.series))
                .unwrap()
                .recognition,
            0
        );
        assert!(tick(&f.library, &fake));
        assert_eq!(*fake.calls.lock().unwrap(), models);
        assert_eq!(decision_count(&f.library), 0);
        let recommendations = f.library.member_recommendations().unwrap();
        assert_eq!(recommendations.len(), 1);
        assert_eq!(recommendations[0].origin, "claude");
        assert_eq!(
            f.library
                .character_confirm_counts(Some(&f.series))
                .unwrap()
                .recognition,
            1
        );
        let r = &recommendations[0];
        f.library.connection().unwrap().execute("INSERT INTO character_tagger_candidates VALUES(?1,?2,?3,'recommendation',0.9,0.9,'now')",params![r.target_id,r.asset_id,r.content_hash]).unwrap();
        // A later tag suggestion of the same pair cannot turn a 6+ result automatic.
        assert!(f.library.claude_build_queue().unwrap().is_empty());
        f.library
            .record_character_decisions(crate::library::characters::DecisionRequest {
                target_id: r.target_id.clone(),
                expected_fingerprint: r.target_fingerprint.clone(),
                asset_ids: vec![r.asset_id.clone()],
                decision: crate::library::characters::DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        assert!(f.library.member_recommendations().unwrap().is_empty());
        assert_eq!(decision_count(&f.library), 1);
    }
}
#[test]
fn member_run_none_leaves_image_unclassified_without_repeated_request() {
    let f = fixture(2);
    start(&f);
    let fake = Fake::new(vec![none()]);
    assert!(tick(&f.library, &fake));
    assert!(!tick(&f.library, &fake));
    assert_eq!(decision_count(&f.library), 0);
    assert!(f.library.member_recommendations().unwrap().is_empty());
    let status = f.library.member_status().unwrap();
    assert_eq!(status.state, "completed");
    assert_eq!(status.done, 1);
    assert!((status.spent_usd - cost_usd(SONNET, 1000, 100, 3000, 500)).abs() < 1e-10);
    assert_eq!(status.reserved_usd, 0.0);
}
#[test]
fn member_run_cap_stops_before_each_request_and_resumes_with_haiku_answer() {
    let f = fixture(6);
    start(&f);
    f.library
        .member_control("settings", Some(0.01), None, None)
        .unwrap();
    let fake = Fake::new(vec![none(), yes(0.95)]);
    assert!(!tick(&f.library, &fake));
    assert_eq!(fake.calls.lock().unwrap().as_slice(), [HAIKU]);
    assert_eq!(f.library.member_status().unwrap().state, "capped");
    f.library
        .member_control("resume", Some(1.0), None, None)
        .unwrap();
    assert!(tick(&f.library, &fake));
    assert_eq!(fake.calls.lock().unwrap().as_slice(), [HAIKU, SONNET]);
    assert_eq!(f.library.member_recommendations().unwrap().len(), 1);
}
#[test]
fn member_run_zero_cap_does_not_send_and_reservations_are_realistic() {
    let f = fixture(5);
    start(&f);
    let (_, s) = f.library.member_next("backlog").unwrap().unwrap();
    assert!(reservation(&s, SONNET) < 0.15);
    f.library
        .member_control("settings", Some(0.0), None, None)
        .unwrap();
    let fake = Fake::new(vec![]);
    assert!(!tick(&f.library, &fake));
    assert!(fake.calls.lock().unwrap().is_empty());
    assert_eq!(f.library.member_status().unwrap().state, "capped");
}
#[test]
fn member_run_restart_preserves_pause_and_ambiguous_request_is_not_retried() {
    let f = fixture(2);
    start(&f);
    let (id, s) = f.library.member_next("backlog").unwrap().unwrap();
    assert!(f.library.member_reserve(id, "backlog", &s, SONNET).unwrap());
    f.library.member_control("pause", None, None, None).unwrap();
    f.library
        .member_control("settings", None, None, Some(false))
        .unwrap();
    let path = f.temp.path().to_owned();
    drop(f.library);
    let l = Library::open(&path).unwrap();
    let fake = Fake::new(vec![]);
    assert_eq!(l.member_status().unwrap().state, "paused");
    assert!(!tick(&l, &fake));
    l.member_control("resume", None, None, None).unwrap();
    assert!(tick(&l, &fake));
    assert!(fake.calls.lock().unwrap().is_empty());
    let status = l.member_status().unwrap();
    assert_eq!(status.failed, 1);
    assert!(status.reserved_usd > 0.0);
}
#[test]
fn member_run_local_cutoff_and_explicit_override() {
    let date = |day| chrono::NaiveDate::from_ymd_opt(2026, 10, day).unwrap();
    assert!(ongoing_on("until", date(26)));
    assert!(!ongoing_on("until", date(27)));
    assert!(ongoing_on("on", date(27)));
    assert!(!ongoing_on("off", date(26)));
}
#[test]
fn member_run_manual_decision_wins_while_response_is_away() {
    let f = fixture(2);
    start(&f);
    let (id, s) = f.library.member_next("backlog").unwrap().unwrap();
    let target = &s.candidates[0].id;
    f.library.connection().unwrap().execute("INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at) VALUES(?1,'asset-5','asset-5',?2,'rejected','x','{}','manual','now')",params![target,s.image.hash]).unwrap();
    let answer: Answer = serde_json::from_value(yes(0.99)).unwrap();
    f.library
        .member_apply(id, &s, &answer, SONNET, "backlog")
        .unwrap();
    assert_eq!(decision_count(&f.library), 1);
    assert_eq!(f.library.member_status().unwrap().done, 1);
}

#[test]
fn member_run_ongoing_uses_monthly_cap_and_ignores_old_arrivals() {
    let f = fixture(2);
    f.library
        .connection()
        .unwrap()
        .execute("UPDATE character_member_control SET ongoing_mode='on'", [])
        .unwrap();
    assert!(f.library.member_next("ongoing").unwrap().is_none());
    let fresh = (Utc::now() + chrono::Duration::seconds(1)).to_rfc3339();
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE assets SET collected_at=?1 WHERE id='asset-5'",
            [fresh],
        )
        .unwrap();
    f.library.claude_state().member_discovered_at = None;
    f.library.set_claude_settings(false, 0.0).unwrap();
    let fake = Fake::new(vec![yes(0.95)]);
    assert!(!tick(&f.library, &fake));
    assert!(fake.calls.lock().unwrap().is_empty());
    f.library.set_claude_settings(false, 1.0).unwrap();
    assert!(tick(&f.library, &fake));
    let monthly = f.library.claude_status(true).unwrap().spent_usd;
    assert!((monthly - cost_usd(SONNET, 1000, 100, 3000, 500)).abs() < 1e-10);
    assert_eq!(f.library.member_status().unwrap().spent_usd, 0.0);
    assert_eq!(decision_count(&f.library), 1);
}

fn add_folder(l: &Library, id: &str, kind: &str, name: &str, parent: Option<&str>) {
    l.connection()
        .unwrap()
        .execute(
            "INSERT INTO classification_entries(id,kind,name,parent_id,created_at) VALUES(?1,?2,?3,?4,'now')",
            params![id, kind, name, parent],
        )
        .unwrap();
}
fn excluded_ids(l: &Library) -> Vec<String> {
    let mut ids = l
        .member_excluded_folders()
        .unwrap()
        .into_iter()
        .map(|f| f.id)
        .collect::<Vec<_>>();
    ids.sort();
    ids
}

#[test]
fn member_exclusions_seed_once_by_name_under_the_other_root_and_keep_user_edits() {
    let f = fixture(2);
    // Nothing to seed from yet: the list stays unseeded until the root exists.
    assert!(excluded_ids(&f.library).is_empty());
    let l = &f.library;
    add_folder(l, "etc", "root", "기타", None);
    add_folder(l, "real", "tag", "실사", Some("etc"));
    add_folder(l, "ai", "tag", "AI", Some("etc"));
    add_folder(l, "series", "tag", "다른 시리즈", Some("etc"));
    add_folder(l, "elsewhere", "root", "다른 곳", None);
    add_folder(l, "elsewhere-real", "tag", "실사", Some("elsewhere"));
    assert_eq!(excluded_ids(l), ["ai", "real"]);
    // A user edit, even an empty list, is never seeded over.
    l.set_member_excluded_folders(&["series".into()]).unwrap();
    assert_eq!(excluded_ids(l), ["series"]);
    l.set_member_excluded_folders(&[]).unwrap();
    assert!(excluded_ids(l).is_empty());
    assert!(l.set_member_excluded_folders(&["missing".into()]).is_err());
}

#[test]
fn member_run_never_analyses_images_in_excluded_folders_or_their_subfolders() {
    let f = fixture(2);
    let l = &f.library;
    add_folder(l, "etc", "root", "기타", None);
    add_folder(l, "real", "tag", "실사", Some("etc"));
    add_folder(l, "real-sub", "tag", "하위", Some("real"));
    l.member_excluded_folders().unwrap();
    l.connection()
        .unwrap()
        .execute(
            "INSERT INTO asset_classifications VALUES('asset-5','real-sub')",
            [],
        )
        .unwrap();
    assert_eq!(l.member_plan().unwrap().total, 0);
    let excluded = excluded_assets(
        &l.connection().unwrap(),
        &["asset-5".into(), "asset-6".into()],
    )
    .unwrap();
    assert_eq!(excluded.into_iter().collect::<Vec<_>>(), ["asset-5"]);
    // Removing the folder from the list makes the same image eligible again.
    l.set_member_excluded_folders(&[]).unwrap();
    assert_eq!(l.member_plan().unwrap().total, 1);
}

// ---- Images that already have exactly one accepted character ("한 명 지정") ----

fn target_ids(l: &Library) -> Vec<String> {
    l.connection()
        .unwrap()
        .prepare("SELECT id FROM character_targets WHERE role='character' ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}
fn decide(l: &Library, target: &str, asset: &str, decision: &str, origin: &str) {
    l.connection().unwrap().execute("INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at) VALUES(?1,?2,?2,(SELECT content_hash FROM assets WHERE id=?2),?3,'x','{}',?4,'now')",params![target,asset,decision,origin]).unwrap();
}
fn recommend(l: &Library, target: &str, asset: &str, series: &str, generation: i64) {
    let c = l.connection().unwrap();
    let evidence = format!("evidence-{target}");
    c.execute("INSERT INTO character_autotag_evidence(id,asset_id,generation,source_generation,content_hash,context_hash,runtime_fingerprint,scope_json,unresolved_regions,created_at) VALUES(?1,?2,?3,1,(SELECT content_hash FROM assets WHERE id=?2),'c','r','{}','[]','now')",params![evidence,asset,generation]).unwrap();
    c.execute("INSERT INTO character_autotag_predictions(evidence_id,target_id,series_id,target_fingerprint,result_json) VALUES(?1,?2,?3,'x','{\"state\":\"recommended\"}')",params![evidence,target,series]).unwrap();
}
fn say(label: &str, confidence: f64) -> Value {
    json!({"present":[{"label":label,"confidence":confidence}],"none":false})
}
fn label_of(s: &Sample, target: &str) -> String {
    probe::label(s.candidates.iter().position(|c| c.id == target).unwrap())
}
fn decisions_on(l: &Library, target: &str) -> i64 {
    l.connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM character_decisions WHERE target_id=?1",
            [target],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn member_run_one_member_image_asks_only_for_additional_members() {
    for (n, confidence, accepted) in [(2, 0.9, true), (5, 0.99, true), (5, 0.899, false)] {
        let f = fixture(n);
        let ids = target_ids(&f.library);
        decide(&f.library, &ids[0], "asset-5", "accepted", "manual");
        let plan = f.library.member_plan().unwrap();
        assert_eq!((plan.total, plan.known_buckets), (1, [1, 0, 0]));
        f.library
            .member_control("start", None, plan.plan_id.as_deref(), None)
            .unwrap();
        let (_, s) = f.library.member_next("backlog").unwrap().unwrap();
        assert_eq!(s.known.as_deref(), Some(ids[0].as_str()));
        assert_eq!(s.candidates.len(), n);
        let known_label = label_of(&s, &ids[0]);
        let other = ids.iter().find(|id| **id != ids[0]).unwrap();
        let body = probe::body(&f.library.canonical_root, &s, SONNET).unwrap();
        let prompt = body.to_string();
        assert!(prompt.contains(&format!("Candidate {known_label} is already known")));
        let allowed = &body["output_config"]["format"]["schema"]["properties"]["present"]["items"]
            ["properties"]["label"]["enum"];
        assert!(!allowed
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l == known_label.as_str()));
        assert_eq!(allowed.as_array().unwrap().len(), n - 1);

        let fake = Fake::new(vec![say(&label_of(&s, other), confidence)]);
        assert!(tick(&f.library, &fake));
        assert_eq!(fake.calls.lock().unwrap().as_slice(), [SONNET]);
        assert_eq!(decision_count(&f.library), 1 + i64::from(accepted));
        assert_eq!(decisions_on(&f.library, &ids[0]), 1);
        let automatic: i64 = f.library.connection().unwrap().query_row("SELECT COUNT(*) FROM character_decisions WHERE origin='automatic' AND target_id=?1 AND decision='accepted'", [other], |r| r.get(0)).unwrap();
        assert_eq!(automatic, i64::from(accepted));
        let recommended = f.library.member_recommendations().unwrap();
        assert_eq!(recommended.len(), usize::from(!accepted));
        assert!(recommended.iter().all(|r| r.target_id == *other));
    }
}

#[test]
fn member_run_known_member_is_never_reported_or_rewritten() {
    let f = fixture(3);
    let ids = target_ids(&f.library);
    decide(&f.library, &ids[0], "asset-5", "accepted", "manual");
    start(&f);
    let (id, s) = f.library.member_next("backlog").unwrap().unwrap();
    let known = label_of(&s, &ids[0]);
    let message = |answer: Value| json!({"stop_reason":"end_turn","content":[{"type":"text","text":answer.to_string()}]});
    assert!(probe::parse_answer(&message(say(&known, 0.99)), &s).is_err());
    // Even a stored answer that names the known member only changes the other one.
    let answer: Answer = serde_json::from_value(json!({"present":[{"label":known,"confidence":0.99},{"label":label_of(&s, &ids[1]),"confidence":0.99}],"none":false})).unwrap();
    f.library
        .member_apply(id, &s, &answer, SONNET, "backlog")
        .unwrap();
    assert_eq!(decisions_on(&f.library, &ids[0]), 1);
    assert_eq!(decisions_on(&f.library, &ids[1]), 1);
}

#[test]
fn member_run_one_member_in_a_large_series_keeps_five_slots_for_the_others() {
    let f = fixture(7);
    let cache =
        Connection::open(f.temp.path().join(".cache/characters/s36_shadow.sqlite")).unwrap();
    let ranked = cache
        .prepare("SELECT target_id FROM scores ORDER BY knn3")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    // The best-scoring member is the known one; it must not use one of the five slots.
    decide(&f.library, &ranked[0], "asset-5", "accepted", "manual");
    let plan = f.library.member_plan().unwrap();
    assert_eq!((plan.total, plan.known_buckets), (1, [0, 1, 0]));
    f.library
        .member_control("start", None, plan.plan_id.as_deref(), None)
        .unwrap();
    let (_, s) = f.library.member_next("backlog").unwrap().unwrap();
    let mut got = s
        .candidates
        .iter()
        .map(|c| c.id.clone())
        .collect::<Vec<_>>();
    got.sort();
    let mut expected = ranked[..6].to_vec();
    expected.sort();
    assert_eq!(got, expected);
    let fake = Fake::new(vec![say(&label_of(&s, &ranked[1]), 0.99)]);
    assert!(tick(&f.library, &fake));
    assert_eq!(fake.calls.lock().unwrap().as_slice(), [HAIKU]);
    assert_eq!(decision_count(&f.library), 1);
    let recommendations = f.library.member_recommendations().unwrap();
    assert_eq!(recommendations.len(), 1);
    assert_eq!(recommendations[0].target_id, ranked[1]);
}

#[test]
fn member_run_resolved_recommendation_is_ignored_and_unresolved_one_still_excludes() {
    let f = fixture(3);
    let ids = target_ids(&f.library);
    let series = f.series.clone();
    decide(&f.library, &ids[0], "asset-5", "accepted", "manual");
    // Resolved: its target already has an accepted decision on this image.
    recommend(&f.library, &ids[0], "asset-5", &series, 1);
    assert_eq!(f.library.member_plan().unwrap().total, 1);
    // Unresolved recommendation for another character stays with the confirmation queue.
    recommend(&f.library, &ids[1], "asset-5", &series, 2);
    assert_eq!(f.library.member_plan().unwrap().total, 0);
    // Once it is rejected it is resolved, and that member is no longer asked about.
    decide(&f.library, &ids[1], "asset-5", "rejected", "manual");
    let plan = f.library.member_plan().unwrap();
    assert_eq!(plan.total, 1);
    let (_, s) = f.library.member_next("backlog").unwrap().unwrap();
    let mut got = s
        .candidates
        .iter()
        .map(|c| c.id.as_str())
        .collect::<Vec<_>>();
    got.sort();
    let mut expected = vec![ids[0].as_str(), ids[2].as_str()];
    expected.sort();
    assert_eq!(got, expected);
}

#[test]
fn member_run_plans_one_member_images_only_with_exactly_one_accepted_character() {
    let f = fixture(4);
    let ids = target_ids(&f.library);
    // Only rejections: not a one-member image, and not an image without decisions either.
    decide(&f.library, &ids[0], "asset-5", "rejected", "manual");
    assert_eq!(f.library.member_plan().unwrap().total, 0);
    decide(&f.library, &ids[1], "asset-5", "accepted", "automatic");
    assert_eq!(f.library.member_plan().unwrap().total, 1);
    // A second accepted character, or a cleared acceptance, takes it out again.
    decide(&f.library, &ids[2], "asset-5", "accepted", "manual");
    assert_eq!(f.library.member_plan().unwrap().total, 0);
    decide(&f.library, &ids[2], "asset-5", "cleared", "manual");
    assert_eq!(f.library.member_plan().unwrap().total, 1);
    decide(&f.library, &ids[1], "asset-5", "cleared", "manual");
    assert_eq!(f.library.member_plan().unwrap().total, 0);
}

#[test]
fn member_run_running_plan_is_untouched_and_a_finished_run_can_be_followed_by_a_new_plan() {
    let f = fixture(3);
    let ids = target_ids(&f.library);
    start(&f);
    assert!(f.library.member_plan().is_err());
    let fake = Fake::new(vec![none()]);
    assert!(tick(&f.library, &fake));
    assert!(!tick(&f.library, &fake));
    let first = f.library.member_status().unwrap();
    assert_eq!(
        (first.state.as_str(), first.done, first.total),
        ("completed", 1, 1)
    );

    // A second image with one accepted character.
    f.library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO asset_classifications VALUES('asset-6',?1)",
            [&f.series],
        )
        .unwrap();
    decide(&f.library, &ids[0], "asset-6", "accepted", "manual");
    let plan = f.library.member_plan().unwrap();
    assert_eq!(plan.state, "draft");
    assert_ne!(plan.plan_id, first.plan_id);
    // Counts describe the new plan; the image analysed before is not offered again.
    assert_eq!(
        (plan.total, plan.done, plan.known_buckets),
        (1, 0, [1, 0, 0])
    );
    f.library
        .member_control("start", None, plan.plan_id.as_deref(), None)
        .unwrap();
    let (_, s) = f.library.member_next("backlog").unwrap().unwrap();
    assert_eq!(s.image.id, "asset-6");
    let fake = Fake::new(vec![say(&label_of(&s, &ids[1]), 0.95)]);
    assert!(tick(&f.library, &fake));
    assert!(!tick(&f.library, &fake));
    let second = f.library.member_status().unwrap();
    assert_eq!(
        (second.state.as_str(), second.done, second.total),
        ("completed", 1, 1)
    );
    // The money spent by the first run still counts against the cap.
    assert!(second.spent_usd > cost_usd(SONNET, 1000, 100, 3000, 500) * 1.5);
    assert_eq!(decisions_on(&f.library, &ids[1]), 1);
}

// ---- One-time backfill of sub-0.9 labels that the earlier rule dropped ----

/// A finished item in a three-member series whose stored Sonnet answer named `ids[1]` at 0.8.
/// The recommendation the new rule wrote is removed again, as if the old rule had run.
fn dropped_label() -> (Fixture, Vec<String>) {
    let f = fixture(3);
    let ids = target_ids(&f.library);
    start(&f);
    let (_, s) = f.library.member_next("backlog").unwrap().unwrap();
    let fake = Fake::new(vec![say(&label_of(&s, &ids[1]), 0.8)]);
    assert!(tick(&f.library, &fake));
    f.library
        .connection()
        .unwrap()
        .execute("DELETE FROM character_member_recommendations", [])
        .unwrap();
    assert!(f.library.member_recommendations().unwrap().is_empty());
    (f, ids)
}
fn backfilled(l: &Library) -> bool {
    l.connection()
        .unwrap()
        .query_row(
            "SELECT recommendations_backfilled FROM character_member_control",
            [],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn member_backfill_recommends_dropped_labels_once() {
    let (f, ids) = dropped_label();
    assert!(!backfilled(&f.library));
    assert_eq!(f.library.member_backfill_recommendations().unwrap(), 1);
    let recommended = f.library.member_recommendations().unwrap();
    assert_eq!(recommended.len(), 1);
    assert_eq!(
        (
            recommended[0].target_id.as_str(),
            recommended[0].asset_id.as_str()
        ),
        (ids[1].as_str(), "asset-5")
    );
    assert_eq!(decision_count(&f.library), 0);
    assert!(backfilled(&f.library));
    // Later runs do nothing, even when the recommendation has gone again.
    f.library
        .connection()
        .unwrap()
        .execute("DELETE FROM character_member_recommendations", [])
        .unwrap();
    assert_eq!(f.library.member_backfill_recommendations().unwrap(), 0);
    assert!(f.library.member_recommendations().unwrap().is_empty());
}

#[test]
fn member_backfill_skips_images_that_changed_since() {
    type Change = fn(&Fixture, &[String]);
    let changes: [(&str, Change); 5] = [
        ("decided", |f, ids| {
            decide(&f.library, &ids[2], "asset-5", "rejected", "manual")
        }),
        ("recommended", |f, ids| {
            let series = f.series.clone();
            recommend(&f.library, &ids[2], "asset-5", &series, 1)
        }),
        ("hash changed", |f, _| {
            f.library
                .connection()
                .unwrap()
                .execute(
                    "UPDATE assets SET content_hash='changed' WHERE id='asset-5'",
                    [],
                )
                .unwrap();
        }),
        ("tagger pending", |f, ids| {
            let hash: String = f
                .library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT content_hash FROM assets WHERE id='asset-5'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            f.library.connection().unwrap().execute("INSERT INTO character_tagger_candidates VALUES(?1,'asset-5',?2,'recommendation',0.9,0.9,'now')", params![ids[2], hash]).unwrap();
        }),
        ("excluded folder", |f, _| {
            let l = &f.library;
            add_folder(l, "etc", "root", "기타", None);
            add_folder(l, "real", "tag", "실사", Some("etc"));
            l.member_excluded_folders().unwrap();
            l.connection()
                .unwrap()
                .execute(
                    "INSERT INTO asset_classifications VALUES('asset-5','real')",
                    [],
                )
                .unwrap();
        }),
    ];
    for (name, change) in changes {
        let (f, ids) = dropped_label();
        change(&f, &ids);
        let before = f.library.member_recommendations().unwrap().len();
        assert_eq!(
            f.library.member_backfill_recommendations().unwrap(),
            0,
            "{name}"
        );
        assert_eq!(
            f.library.member_recommendations().unwrap().len(),
            before,
            "{name}"
        );
        assert!(backfilled(&f.library), "{name}");
    }
}

#[test]
fn member_backfill_leaves_large_series_and_accepted_labels_alone() {
    let f = fixture(6);
    start(&f);
    assert!(tick(&f.library, &Fake::new(vec![yes(0.95)])));
    f.library
        .connection()
        .unwrap()
        .execute("DELETE FROM character_member_recommendations", [])
        .unwrap();
    assert_eq!(f.library.member_backfill_recommendations().unwrap(), 0);
    let f = fixture(3);
    start(&f);
    assert!(tick(&f.library, &Fake::new(vec![yes(0.95)])));
    assert_eq!(decision_count(&f.library), 1);
    assert_eq!(f.library.member_backfill_recommendations().unwrap(), 0);
    assert!(f.library.member_recommendations().unwrap().is_empty());
}
