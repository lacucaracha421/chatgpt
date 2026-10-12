//! Offline tests of the Claude judgment: a fake transport stands in for the network and a
//! temporary library with real (tiny) image files for the media.
use super::*;
use crate::library::character_shadow_review::ShadowReviewQuery;
use crate::library::characters::{tests::Fixture, DecisionKind, DecisionRequest, Target};
use chrono::TimeZone;
use std::sync::Mutex;

// -- pure pieces ---------------------------------------------------------------------------

fn opinion(verdict: Verdict, confidence: Option<f64>) -> Opinion {
    Opinion {
        verdict,
        confidence,
        reason: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
    }
}

#[test]
fn cascade_follows_the_approved_rules() {
    let yes = |c| opinion(Verdict::Yes, Some(c));
    let no = opinion(Verdict::No, Some(0.9));
    let unsure = opinion(Verdict::Unsure, Some(0.5));
    let refused = opinion(Verdict::Refused, None);
    assert_eq!(cascade(None, None), Step::AskHaiku);
    // Haiku yes accepts at once, whatever its confidence.
    assert_eq!(cascade(Some(&yes(0.2)), None), Step::Done(Outcome::Accept));
    // Anything but yes goes on to Sonnet.
    for haiku in [&no, &unsure, &refused] {
        assert_eq!(cascade(Some(haiku), None), Step::AskSonnet);
    }
    let haiku = &unsure;
    assert_eq!(cascade(Some(haiku), Some(&no)), Step::Done(Outcome::Reject));
    assert_eq!(
        cascade(Some(haiku), Some(&yes(0.95))),
        Step::Done(Outcome::Accept)
    );
    assert_eq!(
        cascade(Some(haiku), Some(&yes(0.9))),
        Step::Done(Outcome::Accept)
    );
    assert_eq!(
        cascade(Some(haiku), Some(&yes(0.8))),
        Step::Done(Outcome::Leave)
    );
    assert_eq!(
        cascade(Some(haiku), Some(&unsure)),
        Step::Done(Outcome::Leave)
    );
    assert_eq!(
        cascade(Some(haiku), Some(&refused)),
        Step::Done(Outcome::Leave)
    );
}

#[test]
fn request_body_is_the_same_for_both_models_but_the_model_name() {
    let content = message_content(
        &[("h1".into(), "AAAA".into()), ("h2".into(), "BBBB".into())],
        "Alice",
        Some("Wonderland"),
        "CCCC",
    );
    let haiku = request_body(HAIKU, &content);
    let sonnet = request_body(SONNET, &content);
    assert_eq!(haiku["model"], "claude-haiku-5-5");
    assert_eq!(sonnet["model"], "claude-sonnet-5-5");
    let mut same = haiku.clone();
    same["model"] = sonnet["model"].clone();
    assert_eq!(same, sonnet);
    assert_eq!(haiku["max_tokens"], 2000);
    assert_eq!(haiku["output_config"]["effort"], "low");
    let format = &haiku["output_config"]["format"];
    assert_eq!(format["type"], "json_schema");
    assert_eq!(
        format["schema"]["properties"]["same_character"]["enum"],
        json!(["yes", "no", "unsure"])
    );
    assert_eq!(
        format["schema"]["required"],
        json!(["same_character", "confidence", "reason"])
    );
    assert_eq!(format["schema"]["additionalProperties"], false);
    for forbidden in [
        "thinking",
        "temperature",
        "top_p",
        "tool_choice",
        "fallbacks",
    ] {
        assert!(haiku.get(forbidden).is_none(), "{forbidden}");
    }
    let blocks = haiku["messages"][0]["content"].as_array().unwrap();
    let kinds = blocks
        .iter()
        .map(|b| b["type"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        kinds,
        ["text", "image", "text", "image", "text", "image", "text"]
    );
    assert_eq!(blocks[0]["text"], "Reference 1: Alice (Wonderland)");
    assert_eq!(blocks[2]["text"], "Reference 2: Alice (Wonderland)");
    assert_eq!(blocks[4]["text"], "Candidate:");
    assert_eq!(blocks[6]["text"], QUESTION);
    assert_eq!(blocks[1]["source"]["media_type"], "image/jpeg");
    assert_eq!(blocks[1]["source"]["type"], "base64");
    assert_eq!(blocks[5]["source"]["data"], "CCCC");
    // A series without a name is described as unknown.
    let unnamed = message_content(&[("h".into(), "A".into())], "Bob", None, "C");
    assert_eq!(unnamed[0]["text"], "Reference 1: Bob (unknown series)");
}

fn message(stop_reason: &str, text: &str) -> String {
    json!({
        "stop_reason": stop_reason,
        "content": [{"type": "thinking", "thinking": "x"}, {"type": "text", "text": text}],
        "usage": {"input_tokens": 1200, "output_tokens": 80}
    })
    .to_string()
}

#[test]
fn responses_are_parsed_by_stop_reason_first() {
    for (answer, verdict) in [
        ("yes", Verdict::Yes),
        ("no", Verdict::No),
        ("unsure", Verdict::Unsure),
    ] {
        let text =
            json!({"same_character": answer, "confidence": 0.75, "reason": "why"}).to_string();
        let parsed = parse_message(&message("end_turn", &text)).unwrap();
        assert_eq!(parsed.verdict, verdict);
        assert_eq!(parsed.confidence, Some(0.75));
        assert_eq!(parsed.reason.as_deref(), Some("why"));
        assert_eq!((parsed.input_tokens, parsed.output_tokens), (1200, 80));
    }
    // A refusal is an answer, billed, and no JSON is read from it.
    let refused = parse_message(&message("refusal", "I can't help with that")).unwrap();
    assert_eq!(refused.verdict, Verdict::Refused);
    assert_eq!((refused.input_tokens, refused.output_tokens), (1200, 80));
    // A truncated answer is an error even when its text happens to be valid.
    let valid = json!({"same_character": "yes", "confidence": 1, "reason": ""}).to_string();
    assert_eq!(
        parse_message(&message("max_tokens", &valid)),
        Err(CallError::Invalid)
    );
    // Bad JSON, an unknown verdict, a missing text block.
    assert_eq!(
        parse_message(&message("end_turn", "not json")),
        Err(CallError::Invalid)
    );
    let odd = json!({"same_character": "maybe", "confidence": 0.5, "reason": ""}).to_string();
    assert_eq!(
        parse_message(&message("end_turn", &odd)),
        Err(CallError::Invalid)
    );
    assert_eq!(parse_message("{}"), Err(CallError::Invalid));
    assert_eq!(parse_message("nope"), Err(CallError::Invalid));
    // Confidence is clamped and the reason bounded.
    let long = "가".repeat(900);
    let text = json!({"same_character": "yes", "confidence": 7.0, "reason": long}).to_string();
    let parsed = parse_message(&message("end_turn", &text)).unwrap();
    assert_eq!(parsed.confidence, Some(1.0));
    assert_eq!(parsed.reason.unwrap().chars().count(), 500);
}

#[test]
fn reference_key_names_the_evidence() {
    let key = reference_key(["a", "b", "c"]);
    assert_eq!(key.len(), 64);
    assert!(key
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    assert_eq!(key, reference_key(["a", "b", "c"]));
    assert_eq!(key, hex(&Sha256::digest(b"a\nb\nc")));
    assert_ne!(key, reference_key(["a", "c", "b"]), "slot order matters");
    assert_ne!(key, reference_key(["a", "b"]));
    assert_ne!(key, reference_key(["a", "b", "d"]));
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn base64_matches_the_standard_vectors() {
    for (input, expected) in [
        ("", ""),
        ("f", "Zg=="),
        ("fo", "Zm8="),
        ("foo", "Zm9v"),
        ("foob", "Zm9vYg=="),
        ("fooba", "Zm9vYmE="),
        ("foobar", "Zm9vYmFy"),
    ] {
        assert_eq!(base64(input.as_bytes()), expected);
    }
    assert_eq!(base64(&[0xfb, 0xff, 0xfe]), "+//+");
}

#[test]
fn images_shrink_to_the_edge_limit_and_are_never_enlarged() {
    let wide = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        2000,
        1000,
        image::Rgb([9, 9, 9]),
    ));
    let jpeg = jpeg_for_model(wide).unwrap();
    assert_eq!(&jpeg[..2], &[0xff, 0xd8], "JPEG data");
    let decoded = image::load_from_memory(&jpeg).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (1568, 784));
    let small = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        100,
        50,
        image::Rgba([0, 0, 0, 0]),
    ));
    let decoded = image::load_from_memory(&jpeg_for_model(small).unwrap())
        .unwrap()
        .to_rgb8();
    assert_eq!((decoded.width(), decoded.height()), (100, 50));
    // Transparency is flattened over white.
    assert!(decoded.get_pixel(50, 25).0.iter().all(|c| *c > 240));
}

#[test]
fn prices_and_the_month_follow_the_local_calendar() {
    assert!((cost_usd(HAIKU, 1_000_000, 1_000_000, 0, 0) - 0.60).abs() < 1e-9);
    assert!((cost_usd(SONNET, 1_000_000, 1_000_000, 0, 0) - 12.0).abs() < 1e-9);
    let now = Local.with_ymd_and_hms(2026, 10, 12, 21, 30, 0).unwrap();
    let start = DateTime::parse_from_rfc3339(&month_start(now))
        .unwrap()
        .with_timezone(&Local);
    assert_eq!(
        (
            start.year(),
            start.month(),
            start.day(),
            start.hour_minute()
        ),
        (2026, 10, 1, (0, 0))
    );
    assert_eq!(month_label(now), "2026-10");
}

trait HourMinute {
    fn hour_minute(&self) -> (u32, u32);
}
impl HourMinute for DateTime<Local> {
    fn hour_minute(&self) -> (u32, u32) {
        use chrono::Timelike;
        (self.hour(), self.minute())
    }
}

// -- the fake network ----------------------------------------------------------------------

type Script = dyn Fn(&str, usize) -> std::result::Result<Reply, ()> + Send + Sync;

struct Fake {
    script: Box<Script>,
    calls: Mutex<Vec<Value>>,
}

impl Fake {
    fn new(
        script: impl Fn(&str, usize) -> std::result::Result<Reply, ()> + Send + Sync + 'static,
    ) -> Self {
        Self {
            script: Box::new(script),
            calls: Mutex::default(),
        }
    }
    fn count(&self, model: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call["model"] == model)
            .count()
    }
    fn total(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

impl Transport for Fake {
    fn post(&self, api_key: &str, body: &[u8]) -> std::result::Result<Reply, ()> {
        assert_eq!(api_key, "sk-ant-test");
        let call: Value = serde_json::from_slice(body).unwrap();
        let model = call["model"].as_str().unwrap().to_owned();
        let index = self
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c["model"] == model.as_str())
            .count();
        self.calls.lock().unwrap().push(call);
        (self.script)(&model, index)
    }
    fn pause(&self, _wait: Duration, _stop: &AtomicBool) {}
}

fn answer(verdict: &str, confidence: f64) -> std::result::Result<Reply, ()> {
    let text = json!({"same_character": verdict, "confidence": confidence, "reason": "because"})
        .to_string();
    Ok(Reply {
        status: 200,
        retry_after: None,
        body: message("end_turn", &text),
    })
}

fn status(code: u16) -> std::result::Result<Reply, ()> {
    Ok(Reply {
        status: code,
        retry_after: Some(Duration::from_secs(1)),
        body: "{}".into(),
    })
}

// -- a library with open pairs -------------------------------------------------------------

struct Env {
    f: Fixture,
    target: Target,
}

fn content_hash(asset: &str) -> String {
    hex(&Sha256::digest(asset.as_bytes()))
}

fn write_png(f: &Fixture, id: &str, shade: u8) {
    image::RgbImage::from_pixel(8, 6, image::Rgb([shade, 255 - shade, 100]))
        .save(f.temp.path().join(format!("assets/{id}.png")))
        .unwrap();
}

/// A series-level image with a real file.
fn series_asset(f: &Fixture, id: &str) {
    let exists: bool = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1)",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    if exists {
        return;
    }
    write_png(f, id, 200);
    let thumbnail = format!("thumbnails/{id}.webp");
    std::fs::write(f.temp.path().join(&thumbnail), id.as_bytes()).unwrap();
    let c = f.library.connection().unwrap();
    c.execute(
        "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
         VALUES(?1,?2,'image',?1,?3,?4,7,3,2,'2026-09-08','normal')",
        params![id, content_hash(id), format!("assets/{id}.png"), thumbnail],
    )
    .unwrap();
    c.execute(
        "INSERT INTO asset_classifications VALUES(?1,?2)",
        params![id, f.series],
    )
    .unwrap();
}

fn env() -> Env {
    let f = Fixture::new();
    for (index, id) in ["asset-0", "asset-1", "asset-2", "asset-3", "asset-4"]
        .iter()
        .enumerate()
    {
        write_png(&f, id, (index as u8) * 40);
    }
    let target = f.ready("Alice");
    f.library.set_claude_settings(true, 10.0).unwrap();
    Env { f, target }
}

const OLD: &str = "2026-01-01T00:00:00Z";

/// An S36 candidate (a folded 인식 추천: the fixture character is far from learning).
fn s36(e: &Env, asset: &str, verdict: &str) {
    series_asset(&e.f, asset);
    crate::library::character_shadow::Cache::open(e.f.temp.path()).unwrap();
    let c = rusqlite::Connection::open(e.f.temp.path().join(".cache/characters/s36_shadow.sqlite"))
        .unwrap();
    c.execute(
        "INSERT OR REPLACE INTO scores(asset_id,content_hash,target_id,knn3,verdict,policy_version,feature_id,native_outcome,native_at,scored_at,prior_manual_rejections)
         VALUES(?1,?2,?3,0.1,?4,'v1','feature','none',?5,?5,100)",
        params![asset, content_hash(asset), e.target.id, verdict, OLD],
    )
    .unwrap();
}

/// A pending 태그 추천.
fn tag_pair(e: &Env, asset: &str) {
    series_asset(&e.f, asset);
    e.f.library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO character_tagger_candidates VALUES(?1,?2,?3,'recommendation',0.9,0.9,?4)",
            params![e.target.id, asset, content_hash(asset), OLD],
        )
        .unwrap();
}

/// An S36 doubtful placement: an automatic acceptance that S36 does not support.
fn doubtful(e: &Env, asset: &str) {
    s36(e, asset, "none");
    e.f.library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
             VALUES(?1,?2,?2,?3,'accepted',?4,'{}','automatic','2026-02-01T00:00:00Z')",
            params![e.target.id, asset, content_hash(asset), e.target.fingerprint],
        )
        .unwrap();
}

fn run(e: &Env, fake: &Fake) -> usize {
    let stop = AtomicBool::new(false);
    let key = || Some("sk-ant-test".to_owned());
    let mut turns = 0;
    while e.f.library.claude_step(&stop, fake, &key) {
        turns += 1;
        assert!(turns < 200, "the run never ends");
    }
    turns
}

fn page_assets(e: &Env, mode: Option<&str>) -> Vec<String> {
    e.f.library
        .character_shadow_review_page(ShadowReviewQuery {
            offset: 0,
            limit: 200,
            mode: mode.map(str::to_owned),
            series_id: None,
        })
        .unwrap()
        .items
        .into_iter()
        .map(|item| item.asset_id)
        .collect()
}

fn tag_assets(e: &Env) -> Vec<String> {
    e.f.library
        .tagger_review_items()
        .unwrap()
        .into_iter()
        .map(|item| item.asset.id)
        .collect()
}

/// (decision, origin, engine) of the pair's newest decision.
fn newest(e: &Env, asset: &str) -> Option<(String, String, Option<String>)> {
    e.f.library
        .connection()
        .unwrap()
        .query_row(
            "SELECT decision,origin,json_extract(reference_snapshot,'$.prediction.engine') FROM character_decisions
             WHERE target_id=?1 AND source_asset_id=?2 ORDER BY sequence DESC LIMIT 1",
            params![e.target.id, asset],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .unwrap()
}

fn opinions(e: &Env, asset: &str) -> Vec<(String, String, f64)> {
    let c = e.f.library.connection().unwrap();
    let mut statement = c
        .prepare(
            "SELECT model,verdict,COALESCE(confidence,-1) FROM character_claude_opinions
             WHERE asset_hash=?1 ORDER BY model",
        )
        .unwrap();
    statement
        .query_map([content_hash(asset)], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap()
}

fn manual(e: &Env, asset: &str, decision: DecisionKind) {
    let target = e.f.library.get_character_target(&e.target.id).unwrap();
    e.f.library
        .record_character_decisions(DecisionRequest {
            target_id: target.id,
            expected_fingerprint: target.fingerprint,
            asset_ids: vec![asset.into()],
            decision,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
}

// -- the cascade on real pairs -------------------------------------------------------------

fn person_evidence(e: &Env, asset: &str, generation: i64, hash: &str, evidence: Value) {
    let c = e.f.library.connection().unwrap();
    c.execute(
        "UPDATE assets SET width=1000,height=1000 WHERE id=?1",
        [asset],
    )
    .unwrap();
    let id = format!("person-{asset}-{generation}");
    c.execute(
        "INSERT INTO character_autotag_evidence(id,asset_id,generation,source_generation,content_hash,context_hash,runtime_fingerprint,scope_json,unresolved_regions,created_at)
         VALUES(?1,?2,?3,1,?4,'c','r','{}','[]',?5)",
        params![id,asset,generation,hash,OLD],
    ).unwrap();
    c.execute(
        "INSERT INTO character_autotag_predictions(evidence_id,target_id,series_id,target_fingerprint,result_json) VALUES(?1,?2,?3,?4,?5)",
        params![id,e.target.id,e.f.series,e.target.fingerprint,json!({"evidence":evidence}).to_string()],
    ).unwrap();
}

fn person_box(height: u32) -> Value {
    // The matched box is the second box; the first is deliberately large.
    json!({"passed":true,"bestQueryCrop":1,"queryBoxes":[[0,0,900,900],[20,30,80,30+height]]})
}

#[test]
fn tiny_person_haiku_yes_stays_on_both_pages_and_is_not_asked_again() {
    let e = env();
    s36(&e, "tiny-s36", "recommended");
    tag_pair(&e, "tiny-tag");
    for asset in ["tiny-s36", "tiny-tag"] {
        person_evidence(&e, asset, 1, &content_hash(asset), person_box(119));
    }
    let fake = Fake::new(|_, _| answer("yes", 0.99));
    run(&e, &fake);
    assert_eq!(fake.count(HAIKU), 2);
    assert_eq!(fake.count(SONNET), 0);
    assert_eq!(page_assets(&e, None), ["tiny-s36"]);
    assert_eq!(tag_assets(&e), ["tiny-tag"]);
    for asset in ["tiny-s36", "tiny-tag"] {
        assert_eq!(newest(&e, asset), None);
        assert_eq!(opinions(&e, asset).len(), 1);
    }
    assert_eq!(e.f.library.claude_status(true).unwrap().left_for_user, 2);
    e.f.library.claude_poke();
    assert!(e.f.library.claude_build_queue().unwrap().is_empty());
    run(&e, &fake);
    assert_eq!(fake.total(), 2);
    // The candidate is still encoded as the full 8x6 image, not the matched crop.
    let encoded = e.f.library.claude_encode("assets/tiny-s36.png").unwrap();
    assert!(fake
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|call| call["messages"][0]["content"][9]["source"]["data"] == encoded));
    // A changed reference set permits a new opinion.
    e.f.library
        .connection()
        .unwrap()
        .execute(
            "DELETE FROM character_references WHERE target_id=?1 AND asset_id='asset-0'",
            [&e.target.id],
        )
        .unwrap();
    e.f.library.claude_poke();
    run(&e, &fake);
    assert_eq!(fake.total(), 4);
    assert_eq!(e.f.library.claude_status(true).unwrap().left_for_user, 2);
}

#[test]
fn tiny_person_sonnet_no_is_rejected_with_the_height_in_the_snapshot() {
    let e = env();
    s36(&e, "tiny", "recommended");
    person_evidence(&e, "tiny", 1, &content_hash("tiny"), person_box(100));
    let fake = Fake::new(|model, _| answer(if model == HAIKU { "unsure" } else { "no" }, 0.95));
    run(&e, &fake);
    assert_eq!(newest(&e, "tiny").unwrap().0, "rejected");
    assert!(page_assets(&e, None).is_empty());
    assert_eq!(e.f.library.claude_status(true).unwrap().left_for_user, 0);
    let snapshot: String =
        e.f.library
            .connection()
            .unwrap()
            .query_row(
                "SELECT reference_snapshot FROM character_decisions WHERE source_asset_id='tiny'",
                [],
                |r| r.get(0),
            )
            .unwrap();
    let snapshot: Value = serde_json::from_str(&snapshot).unwrap();
    assert_eq!(snapshot["prediction"]["tinyPerson"], true);
    assert_eq!(snapshot["prediction"]["personHeightRatio"], 0.1);
}

#[test]
fn tiny_person_sonnet_sure_yes_is_also_left_for_the_user() {
    let e = env();
    s36(&e, "tiny", "recommended");
    person_evidence(&e, "tiny", 1, &content_hash("tiny"), person_box(100));
    let fake = Fake::new(|model, _| answer(if model == HAIKU { "no" } else { "yes" }, 0.99));
    run(&e, &fake);
    assert_eq!(newest(&e, "tiny"), None);
    assert_eq!(opinions(&e, "tiny").len(), 2);
    assert_eq!(e.f.library.claude_status(true).unwrap().left_for_user, 1);
    e.f.library.claude_poke();
    run(&e, &fake);
    assert_eq!(fake.total(), 2);
}

#[test]
fn ordinary_person_or_missing_matched_evidence_keeps_accepting() {
    for (asset, evidence) in [
        ("at-threshold", Some(person_box(120))),
        ("above-threshold", Some(person_box(121))),
        ("no-evidence", None),
        (
            "no-box",
            Some(json!({"passed":true,"bestQueryCrop":0,"queryBoxes":[]})),
        ),
    ] {
        for haiku_yes in [true, false] {
            let e = env();
            s36(&e, asset, "recommended");
            if let Some(evidence) = evidence.clone() {
                person_evidence(&e, asset, 1, &content_hash(asset), evidence);
            }
            let fake = Fake::new(move |model, _| {
                answer(
                    if haiku_yes || model == SONNET {
                        "yes"
                    } else {
                        "no"
                    },
                    0.99,
                )
            });
            run(&e, &fake);
            assert_eq!(newest(&e, asset).unwrap().0, "accepted", "{asset}");
            assert_eq!(e.f.library.claude_status(true).unwrap().left_for_user, 0);
            let snapshot: String = e
                .f
                .library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT reference_snapshot FROM character_decisions WHERE source_asset_id=?1",
                    [asset],
                    |r| r.get(0),
                )
                .unwrap();
            let snapshot: Value = serde_json::from_str(&snapshot).unwrap();
            assert!(snapshot["prediction"].get("tinyPerson").is_none());
            assert!(snapshot["prediction"].get("personHeightRatio").is_none());
        }
    }
}

#[test]
fn tiny_person_uses_the_newest_matching_content_evidence_only() {
    let e = env();
    s36(&e, "latest", "recommended");
    person_evidence(&e, "latest", 1, &content_hash("latest"), person_box(100));
    person_evidence(&e, "latest", 2, &content_hash("latest"), person_box(120));
    person_evidence(&e, "latest", 3, &"f".repeat(64), person_box(100));
    let fake = Fake::new(|_, _| answer("yes", 0.99));
    run(&e, &fake);
    assert_eq!(newest(&e, "latest").unwrap().0, "accepted");
}

#[test]
fn haiku_yes_accepts_and_the_pair_leaves_every_list() {
    let e = env();
    s36(&e, "cand-s36", "recommended");
    s36(&e, "cand-auto", "automatic");
    tag_pair(&e, "cand-tag");
    doubtful(&e, "cand-doubt");
    // The folded recommendations are open pairs of the 확인 list too.
    let folded = e.f.library.confirm_totals(None).unwrap();
    assert!(folded.folded_items >= 2, "{folded:?}");
    assert_eq!(page_assets(&e, None).len(), 2);
    assert_eq!(page_assets(&e, Some("doubtful")), ["cand-doubt"]);
    assert_eq!(tag_assets(&e), ["cand-tag"]);

    let fake = Fake::new(|_, _| answer("yes", 0.6));
    run(&e, &fake);
    assert_eq!(fake.count(HAIKU), 4);
    assert_eq!(fake.count(SONNET), 0);
    for asset in ["cand-s36", "cand-auto", "cand-tag", "cand-doubt"] {
        assert_eq!(
            newest(&e, asset),
            Some(("accepted".into(), "automatic".into(), Some("claude".into()))),
            "{asset}"
        );
    }
    let membership =
        e.f.library
            .character_relations_for_asset("cand-s36")
            .unwrap();
    assert_eq!(membership, vec![e.target.id.clone()]);
    // Nothing is left on any list or in any count.
    assert!(page_assets(&e, None).is_empty());
    assert!(page_assets(&e, Some("doubtful")).is_empty());
    assert!(tag_assets(&e).is_empty());
    assert!(e.f.library.confirm_tag_pairs().unwrap().is_empty());
    let totals = e.f.library.confirm_totals(None).unwrap();
    assert_eq!(totals.counts, Default::default());
    assert_eq!((totals.folded_items, totals.folded_characters), (0, 0));
    let summary = e.f.library.character_shadow_review_summary().unwrap();
    assert_eq!((summary.automatic, summary.recommended), (0, 0));
    assert_eq!(e.f.library.tagger_review_counts().unwrap().total, 0);
    // The snapshot says who decided.
    let snapshot: String = e
        .f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT reference_snapshot FROM character_decisions WHERE source_asset_id='cand-s36' ORDER BY sequence DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let snapshot: Value = serde_json::from_str(&snapshot).unwrap();
    assert_eq!(snapshot["prediction"]["engine"], "claude");
    assert_eq!(snapshot["prediction"]["haiku"]["verdict"], "yes");
    assert!(snapshot["prediction"]["sonnet"].is_null());
    assert_eq!(
        snapshot["prediction"]["referenceKey"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    assert_eq!(snapshot["references"].as_array().unwrap().len(), 4);
}

#[test]
fn sonnet_decides_what_haiku_does_not_accept() {
    let e = env();
    let plan: BTreeMap<&str, &str> = BTreeMap::from([
        ("n-no", "no"),
        ("n-sure", "yes95"),
        ("n-unsure-yes", "yes80"),
        ("n-unsure", "unsure"),
        ("n-refused", "refused"),
    ]);
    for asset in plan.keys() {
        s36(&e, asset, "recommended");
    }
    // Sonnet is asked in the queue's order, so its answers are scripted by position.
    let queue_order: Vec<String> =
        e.f.library
            .claude_build_queue()
            .unwrap()
            .into_iter()
            .map(|pair| pair.asset_id)
            .collect();
    assert_eq!(queue_order.len(), 5);
    let sonnet_plan: Vec<&str> = queue_order
        .iter()
        .map(|asset| plan[asset.as_str()])
        .collect();
    let fake = Fake::new(move |model, index| {
        if model == HAIKU {
            // Haiku abstains or says no on all of them.
            return if index % 2 == 0 {
                answer("no", 0.7)
            } else {
                answer("unsure", 0.3)
            };
        }
        match sonnet_plan[index] {
            "no" => answer("no", 0.9),
            "yes95" => answer("yes", 0.95),
            "yes80" => answer("yes", 0.8),
            "unsure" => answer("unsure", 0.5),
            _ => Ok(Reply {
                status: 200,
                retry_after: None,
                body: message("refusal", "no"),
            }),
        }
    });
    run(&e, &fake);
    assert_eq!((fake.count(HAIKU), fake.count(SONNET)), (5, 5));
    let state =
        |asset: &str| newest(&e, asset).map(|(d, o, engine)| (d, o, engine.unwrap_or_default()));
    let auto = |d: &str| Some((d.to_owned(), "automatic".to_owned(), "claude".to_owned()));
    assert_eq!(state("n-no"), auto("rejected"));
    assert_eq!(state("n-sure"), auto("accepted"));
    // A less sure yes, an unsure and a refusal stay for the person.
    for asset in ["n-unsure-yes", "n-unsure", "n-refused"] {
        assert_eq!(state(asset), None, "{asset}");
    }
    let mut left = page_assets(&e, None);
    left.sort();
    assert_eq!(left, ["n-refused", "n-unsure", "n-unsure-yes"]);
    assert_eq!(opinions(&e, "n-refused")[1].1, "refused");
    // The membership follows: the rejected pair never belongs, the accepted one does.
    assert!(e
        .f
        .library
        .character_relations_for_asset("n-no")
        .unwrap()
        .is_empty());
    assert_eq!(
        e.f.library
            .character_relations_for_asset("n-sure")
            .unwrap()
            .len(),
        1
    );
    let status = e.f.library.claude_status(true).unwrap();
    assert_eq!(
        (
            status.auto_accepted,
            status.auto_rejected,
            status.left_for_user
        ),
        (1, 1, 3)
    );
    assert_eq!(status.state, "idle");
}

#[test]
fn a_pair_left_for_the_user_is_not_asked_again_until_its_references_change() {
    let e = env();
    s36(&e, "cand-1", "recommended");
    let fake = Fake::new(|model, _| {
        if model == HAIKU {
            answer("unsure", 0.3)
        } else {
            answer("unsure", 0.4)
        }
    });
    run(&e, &fake);
    assert_eq!((fake.count(HAIKU), fake.count(SONNET)), (1, 1));
    assert_eq!(newest(&e, "cand-1"), None);
    assert_eq!(page_assets(&e, None), ["cand-1"]);
    // Again after a restart of the run: nothing is asked.
    e.f.library.claude_poke();
    run(&e, &fake);
    assert_eq!(fake.total(), 2);
    // Other changes to the library (a new pair) do not re-ask the old one either.
    s36(&e, "cand-2", "recommended");
    run(&e, &fake);
    assert_eq!((fake.count(HAIKU), fake.count(SONNET)), (2, 2));
    // Its references change: the key changes and Claude looks again.
    let target = e.f.library.get_character_target(&e.target.id).unwrap();
    write_png(&e.f, "asset-5", 77);
    let reordered = ["asset-5", "asset-1", "asset-2", "asset-3", "asset-4"]
        .map(String::from)
        .to_vec();
    e.f.library
        .replace_character_references(&target.id, target.revision, &reordered)
        .unwrap();
    run(&e, &fake);
    assert_eq!((fake.count(HAIKU), fake.count(SONNET)), (4, 4));
    let keys: i64 = e
        .f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(DISTINCT reference_key) FROM character_claude_opinions WHERE asset_hash=?1",
            [content_hash("cand-1")],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(keys, 2);
}

#[test]
fn up_to_four_references_are_sent_in_slot_order_without_the_candidate() {
    let e = env();
    // asset-0 is a reference of the character and also a scored candidate.
    crate::library::character_shadow::Cache::open(e.f.temp.path()).unwrap();
    rusqlite::Connection::open(e.f.temp.path().join(".cache/characters/s36_shadow.sqlite"))
        .unwrap()
        .execute(
            "INSERT INTO scores(asset_id,content_hash,target_id,knn3,verdict,policy_version,feature_id,native_outcome,native_at,scored_at,prior_manual_rejections)
             VALUES('asset-0',?1,?2,0.1,'recommended','v1','feature','none',?3,?3,100)",
            params![content_hash("asset-0"), e.target.id, OLD],
        )
        .unwrap();
    s36(&e, "cand-1", "recommended");
    let queue = e.f.library.claude_build_queue().unwrap();
    let keys = |asset: &str| {
        queue
            .iter()
            .find(|pair| pair.asset_id == asset)
            .map(|pair| (pair.references.len(), pair.reference_key.clone()))
    };
    let hashes = |ids: &[&str]| {
        reference_key(
            ids.iter()
                .map(|id| content_hash(id))
                .collect::<Vec<_>>()
                .iter()
                .map(String::as_str),
        )
    };
    assert!(keys("asset-0").is_none());
    let (count, key) = keys("cand-1").unwrap();
    assert_eq!(count, 4, "the fifth reference is not sent");
    assert_eq!(key, hashes(&["asset-0", "asset-1", "asset-2", "asset-3"]));
}

#[test]
fn pairs_that_already_have_a_person_or_claude_decision_are_not_asked() {
    let e = env();
    s36(&e, "cand-person", "recommended");
    s36(&e, "cand-cleared", "recommended");
    s36(&e, "cand-open", "recommended");
    manual(&e, "cand-person", DecisionKind::Rejected);
    // A person who took the image out of the folder is not overridden either.
    manual(&e, "cand-cleared", DecisionKind::Cleared);
    let fake = Fake::new(|_, _| answer("yes", 0.9));
    run(&e, &fake);
    assert_eq!(fake.count(HAIKU), 1, "only the open pair is asked");
    assert_eq!(newest(&e, "cand-person").unwrap().1, "manual");
    assert_eq!(newest(&e, "cand-cleared").unwrap().1, "manual");
    // Claude's own decision is not repeated either.
    run(&e, &fake);
    assert_eq!(fake.total(), 1);
}

#[test]
fn a_decision_made_while_a_request_is_out_wins() {
    let e = env();
    s36(&e, "cand-1", "recommended");
    let library = e.f.library.clone();
    let target = e.target.clone();
    let fake = Fake::new(move |_, _| {
        let current = library.get_character_target(&target.id).unwrap();
        library
            .record_character_decisions(DecisionRequest {
                target_id: current.id,
                expected_fingerprint: current.fingerprint,
                asset_ids: vec!["cand-1".into()],
                decision: DecisionKind::Rejected,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        answer("yes", 1.0)
    });
    run(&e, &fake);
    let (decision, origin, _) = newest(&e, "cand-1").unwrap();
    assert_eq!((decision.as_str(), origin.as_str()), ("rejected", "manual"));
    assert!(e
        .f
        .library
        .character_relations_for_asset("cand-1")
        .unwrap()
        .is_empty());
}

#[test]
fn a_changed_image_is_not_decided() {
    let e = env();
    s36(&e, "cand-1", "recommended");
    let library = e.f.library.clone();
    let fake = Fake::new(move |_, _| {
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET content_hash=?1 WHERE id='cand-1'",
                ["f".repeat(64)],
            )
            .unwrap();
        answer("yes", 1.0)
    });
    run(&e, &fake);
    assert_eq!(newest(&e, "cand-1"), None);
}

// -- consequences for the rest of the character machinery ----------------------------------

fn readiness(e: &Env) -> S36Counts {
    let row = e.f.library.character_s36_readiness(&e.f.series).unwrap();
    let row = row.iter().find(|r| r.target_id == e.target.id).unwrap();
    (row.reviewed, row.wrong, row.examples)
}
type S36Counts = (u32, u32, u32);

#[test]
fn claude_decisions_are_not_judgments_or_examples_and_a_person_overrides_them() {
    let e = env();
    s36(&e, "cand-a", "automatic");
    s36(&e, "cand-b", "automatic");
    assert_eq!(readiness(&e), (0, 0, 0));
    let fake = Fake::new(|model, index| {
        if model == HAIKU {
            answer("unsure", 0.2)
        } else if index == 0 {
            answer("yes", 0.99)
        } else {
            answer("no", 0.9)
        }
    });
    run(&e, &fake);
    let accepted = newest(&e, "cand-a").unwrap().0;
    let rejected = newest(&e, "cand-b").unwrap().0;
    let mut decisions = [accepted, rejected];
    decisions.sort();
    assert_eq!(decisions, ["accepted", "rejected"]);
    // Neither a judged candidate, nor a wrong one, nor a positive example.
    assert_eq!(readiness(&e), (0, 0, 0));
    // A person judging the same pair afterwards is the only judgment, and the folder follows.
    let rejected_asset = if newest(&e, "cand-a").unwrap().0 == "rejected" {
        "cand-a"
    } else {
        "cand-b"
    };
    assert!(e
        .f
        .library
        .character_relations_for_asset(rejected_asset)
        .unwrap()
        .is_empty());
    manual(&e, rejected_asset, DecisionKind::Accepted);
    assert_eq!(newest(&e, rejected_asset).unwrap().1, "manual");
    assert_eq!(
        e.f.library
            .character_relations_for_asset(rejected_asset)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(readiness(&e), (1, 0, 1));
    // And the other way: a person rejecting what Claude accepted.
    let accepted_asset = if rejected_asset == "cand-a" {
        "cand-b"
    } else {
        "cand-a"
    };
    manual(&e, accepted_asset, DecisionKind::Rejected);
    assert!(e
        .f
        .library
        .character_relations_for_asset(accepted_asset)
        .unwrap()
        .is_empty());
    assert_eq!(readiness(&e), (2, 1, 1));
    // Claude does not touch the pair again.
    let before = fake.total();
    e.f.library.claude_poke();
    run(&e, &fake);
    assert_eq!(fake.total(), before);
    let connection = e.f.library.connection().unwrap();
    let settled = settled_pairs(
        &connection,
        &serde_json::to_string(&[[&e.target.id, "cand-a"], [&e.target.id, "cand-b"]]).unwrap(),
    )
    .unwrap();
    assert!(
        settled.is_empty(),
        "a person's newer decision replaces Claude's"
    );
}

#[test]
fn only_claude_made_accepted_or_rejected_decisions_are_settled() {
    let e = env();
    s36(&e, "cand-1", "recommended");
    doubtful(&e, "cand-2");
    manual(&e, "cand-1", DecisionKind::Accepted);
    let connection = e.f.library.connection().unwrap();
    let pairs = serde_json::to_string(&[
        [&e.target.id, "cand-1"],
        [&e.target.id, "cand-2"],
        [&e.target.id, "nothing"],
    ])
    .unwrap();
    assert!(settled_pairs(&connection, &pairs).unwrap().is_empty());
}

#[test]
fn a_claude_acceptance_is_not_vetoed_again_by_the_taggers() {
    let f = Fixture::new();
    let t = f.ready("A");
    crate::library::tagger_review::tests::signals(&f, &t, 0.0, 0.2);
    crate::library::tagger_review::tests::automatic(&f, &t);
    assert_eq!(f.library.preview_tagger_review().unwrap().veto.count, 1);
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE character_decisions SET reference_snapshot='{\"prediction\":{\"engine\":\"claude\"}}'",
            [],
        )
        .unwrap();
    let preview = f.library.preview_tagger_review().unwrap();
    assert_eq!((preview.veto.count, preview.recommend.count), (0, 0));
}

// -- the run: money, keys, the network, settings -------------------------------------------

#[test]
fn the_monthly_cap_stops_the_run_before_the_request_that_would_exceed_it() {
    let e = env();
    s36(&e, "cand-1", "recommended");
    s36(&e, "cand-2", "recommended");
    // Haiku answers cost $0.10 + $0.0005; the cap of $0.05 is passed by the first answer.
    let fake = Fake::new(|_, _| {
        let text = json!({"same_character": "unsure", "confidence": 0.1, "reason": ""}).to_string();
        Ok(Reply {
            status: 200,
            retry_after: None,
            body: json!({"stop_reason":"end_turn","content":[{"type":"text","text":text}],
                "usage":{"input_tokens":1_000_000,"output_tokens":0}})
            .to_string(),
        })
    });
    e.f.library.set_claude_settings(true, 0.05).unwrap();
    run(&e, &fake);
    assert_eq!(fake.total(), 1, "no request after the cap is reached");
    let status = e.f.library.claude_status(true).unwrap();
    assert_eq!(status.state, "capped");
    assert!((status.spent_usd - 0.10).abs() < 1e-9);
    assert_eq!(status.cap_usd, 0.05);
    // Raising the cap continues at once.
    e.f.library.set_claude_settings(true, 5.0).unwrap();
    run(&e, &fake);
    assert!(fake.total() > 1);
    assert_ne!(e.f.library.claude_status(true).unwrap().state, "capped");
}

#[test]
fn spend_counts_only_this_local_months_rows() {
    let e = env();
    let c = e.f.library.connection().unwrap();
    let insert = |hash: &str, model: &str, at: &str| {
        c.execute(
            "INSERT INTO character_claude_opinions(target_id,asset_hash,reference_key,model,verdict,input_tokens,output_tokens,created_at)
             VALUES(?1,?2,'k',?3,'yes',1000000,0,?4)",
            params![e.target.id, hash, model, at],
        )
        .unwrap();
    };
    let now = Local::now();
    insert("this-month", SONNET, &now.with_timezone(&Utc).to_rfc3339());
    insert("old", SONNET, "2020-01-01T00:00:00+00:00");
    let spent = spend_usd(&c, &month_start(now)).unwrap();
    assert!((spent - 2.0).abs() < 1e-9, "{spent}");
}

#[test]
fn a_refused_key_stops_the_run_until_the_key_changes() {
    let e = env();
    s36(&e, "cand-1", "recommended");
    s36(&e, "cand-2", "recommended");
    let fake = Fake::new(|_, index| {
        if index == 0 {
            status(401)
        } else {
            answer("yes", 1.0)
        }
    });
    run(&e, &fake);
    assert_eq!(fake.total(), 1);
    assert_eq!(e.f.library.claude_status(true).unwrap().state, "credential");
    assert!(
        opinions(&e, "cand-1").is_empty(),
        "nothing is stored for a failed request"
    );
    run(&e, &fake);
    assert_eq!(fake.total(), 1, "no more requests with a refused key");
    // A new key (poke) tries again.
    e.f.library.claude_poke();
    run(&e, &fake);
    assert!(fake.total() >= 3);
    assert_eq!(e.f.library.claude_status(true).unwrap().state, "idle");
}

#[test]
fn rate_limits_and_server_errors_back_off_and_retry_twice() {
    let e = env();
    s36(&e, "cand-1", "recommended");
    let fake = Fake::new(|_, index| match index {
        0 => status(429),
        1 => status(503),
        _ => answer("yes", 0.9),
    });
    run(&e, &fake);
    assert_eq!(fake.count(HAIKU), 3);
    assert_eq!(newest(&e, "cand-1").unwrap().0, "accepted");

    // Three failures end the pair for this run: nothing stored, nothing decided.
    let e = env();
    s36(&e, "cand-1", "recommended");
    let fake = Fake::new(|_, _| status(500));
    run(&e, &fake);
    assert_eq!(fake.count(HAIKU), 3);
    assert!(opinions(&e, "cand-1").is_empty());
    assert_eq!(newest(&e, "cand-1"), None);
    assert_eq!(e.f.library.claude_status(true).unwrap().state, "error");
    // A connection that never opens is the same.
    let e = env();
    s36(&e, "cand-1", "recommended");
    let fake = Fake::new(|_, _| Err(()));
    run(&e, &fake);
    assert_eq!(fake.count(HAIKU), 3);
    assert!(opinions(&e, "cand-1").is_empty());
}

#[test]
fn a_request_the_api_refuses_skips_only_that_pair() {
    let e = env();
    s36(&e, "cand-1", "recommended");
    s36(&e, "cand-2", "recommended");
    let fake = Fake::new(|_, index| {
        if index == 0 {
            status(400)
        } else {
            answer("yes", 0.9)
        }
    });
    run(&e, &fake);
    assert_eq!(fake.count(HAIKU), 2);
    let decided = ["cand-1", "cand-2"]
        .iter()
        .filter(|asset| newest(&e, asset).is_some())
        .count();
    assert_eq!(decided, 1);
}

#[test]
fn nothing_runs_while_the_setting_is_off_or_the_key_is_missing() {
    let e = env();
    s36(&e, "cand-1", "recommended");
    let fake = Fake::new(|_, _| answer("yes", 1.0));
    e.f.library.set_claude_settings(false, 10.0).unwrap();
    run(&e, &fake);
    assert_eq!(fake.total(), 0);
    assert_eq!(e.f.library.claude_status(true).unwrap().state, "off");
    // On, but no key.
    e.f.library.set_claude_settings(true, 10.0).unwrap();
    let stop = AtomicBool::new(false);
    assert!(!e.f.library.claude_step(&stop, &fake, &|| None));
    assert_eq!(fake.total(), 0);
    assert_eq!(e.f.library.claude_status(false).unwrap().state, "no_key");
    assert!(
        !e.f.library.claude_wanted(),
        "the idle chain skips the step until a poke"
    );
    e.f.library.claude_poke();
    assert!(e.f.library.claude_wanted());
    run(&e, &fake);
    assert_eq!(fake.total(), 1);
}

#[test]
fn a_stopped_run_asks_nothing() {
    let e = env();
    s36(&e, "cand-1", "recommended");
    let fake = Fake::new(|_, _| answer("yes", 1.0));
    let stop = AtomicBool::new(true);
    assert!(!e
        .f
        .library
        .claude_step(&stop, &fake, &|| Some("sk-ant-test".into())));
    assert_eq!(fake.total(), 0);
}

#[test]
fn settings_default_to_off_and_ten_dollars_and_are_validated() {
    let f = Fixture::new();
    assert_eq!(
        f.library.claude_settings().unwrap(),
        ClaudeSettings {
            enabled: false,
            monthly_cap_usd: DEFAULT_MONTHLY_CAP_USD
        }
    );
    let saved = f.library.set_claude_settings(true, 20.0).unwrap();
    assert_eq!(f.library.claude_settings().unwrap(), saved);
    for bad in [-1.0, f64::NAN, f64::INFINITY, 1e9] {
        assert!(f.library.set_claude_settings(true, bad).is_err());
    }
    assert_eq!(f.library.claude_settings().unwrap().monthly_cap_usd, 20.0);
    let status = f.library.claude_status(true).unwrap();
    assert_eq!(status.state, "idle");
    assert_eq!(serde_json::to_value(&status).unwrap()["leftForUser"], 0);
}

#[test]
fn opinion_verdicts_are_constrained_by_the_table() {
    let e = env();
    s36(&e, "cand-1", "recommended");
    let fake = Fake::new(|_, _| answer("unsure", 0.1));
    run(&e, &fake);
    assert!(!opinions(&e, "cand-1").is_empty());
    let c = e.f.library.connection().unwrap();
    // The CHECK on the verdict column rejects anything else.
    let bad = c.execute(
        "INSERT INTO character_claude_opinions(target_id,asset_hash,reference_key,model,verdict,created_at) VALUES(?1,'h','k','m','maybe','now')",
        [&e.target.id],
    );
    assert!(bad.is_err());
}

#[test]
fn cache_breakpoint_ends_the_identical_reference_prefix() {
    let e = env();
    s36(&e, "cand-1", "recommended");
    s36(&e, "cand-2", "recommended");
    write_png(&e.f, "cand-2", 33);
    let fake = Fake::new(|_, _| answer("yes", 0.9));
    run(&e, &fake);
    let calls = fake.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    let first = calls[0]["messages"][0]["content"].as_array().unwrap();
    let second = calls[1]["messages"][0]["content"].as_array().unwrap();
    for blocks in [first, second] {
        for (index, block) in blocks.iter().enumerate() {
            if index == 7 {
                assert_eq!(block["type"], "image");
                assert_eq!(block["cache_control"], json!({"type":"ephemeral"}));
            } else {
                assert!(block.get("cache_control").is_none());
            }
        }
    }
    assert_eq!(
        serde_json::to_vec(&first[..=7]).unwrap(),
        serde_json::to_vec(&second[..=7]).unwrap()
    );
    assert_ne!(first[9], second[9]);
    // A shorter reference set still has exactly one breakpoint, on its last image.
    let one = message_content(&[("h".into(), "A".into())], "A", None, "B");
    assert_eq!(one[1]["cache_control"], json!({"type":"ephemeral"}));
    assert_eq!(
        one.iter()
            .filter(|b| b.get("cache_control").is_some())
            .count(),
        1
    );
}

#[test]
fn jpeg_encoding_is_deterministic_including_resize_and_alpha() {
    let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(1600, 20, |x, y| {
        image::Rgba([x as u8, y as u8, (x + y) as u8, (x % 256) as u8])
    }));
    assert_eq!(jpeg_for_model(image.clone()), jpeg_for_model(image));
}

#[test]
fn base_and_learned_reference_pairs_never_reach_transport() {
    let e = env();
    s36(&e, "asset-0", "recommended");
    s36(&e, "learned", "recommended");
    s36(&e, "candidate", "recommended");
    e.f.library.connection().unwrap().execute(
        "INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at) VALUES(?1,'learned',?2,?3)",
        params![e.target.id, content_hash("learned"), OLD],
    ).unwrap();
    let queue = e.f.library.claude_build_queue().unwrap();
    assert_eq!(
        queue
            .iter()
            .map(|p| p.asset_id.as_str())
            .collect::<Vec<_>>(),
        ["candidate"]
    );
    let fake = Fake::new(|_, _| answer("yes", 0.9));
    run(&e, &fake);
    assert_eq!(fake.total(), 1);
    assert!(opinions(&e, "asset-0").is_empty());
    assert!(opinions(&e, "learned").is_empty());
    assert_eq!(newest(&e, "candidate").unwrap().0, "accepted");
}

#[test]
fn queue_groups_targets_stably_in_first_appearance_order() {
    let e = env();
    let other = e.f.ready("Bob");
    tag_pair(&e, "tag-a");
    series_asset(&e.f, "tag-b");
    e.f.library.connection().unwrap().execute(
        "INSERT INTO character_tagger_candidates VALUES(?1,'tag-b',?2,'recommendation',0.9,0.9,?3)",
        params![other.id, content_hash("tag-b"), OLD],
    ).unwrap();
    let first_target = e.f.library.confirm_tag_pairs().unwrap()[0].0.clone();
    s36(&e, "shadow-a", "recommended");
    rusqlite::Connection::open(e.f.temp.path().join(".cache/characters/s36_shadow.sqlite"))
        .unwrap()
        .execute(
            "UPDATE scores SET target_id=?1 WHERE asset_id='shadow-a'",
            [&first_target],
        )
        .unwrap();
    let open = e.f.library.claude_open_pairs().unwrap();
    let mut order = Vec::new();
    for (target, _) in &open {
        if !order.contains(target) {
            order.push(target.clone());
        }
    }
    assert_eq!(order.len(), 2);
    // Cross back to the first target regardless of the randomly generated target IDs.
    assert_ne!(open[open.len() - 1].0, open[open.len() - 2].0);
    let expected = order
        .iter()
        .flat_map(|target| open.iter().filter(move |(t, _)| t == target).cloned())
        .collect::<Vec<_>>();
    let actual =
        e.f.library
            .claude_build_queue()
            .unwrap()
            .into_iter()
            .map(|p| (p.target_id, p.asset_id))
            .collect::<Vec<_>>();
    assert_eq!(actual, expected);
}

#[test]
fn cache_tokens_parse_price_and_persist_for_month_spend() {
    let text = json!({"same_character":"yes","confidence":0.9,"reason":"ok"}).to_string();
    let absent = parse_message(&message("end_turn", &text)).unwrap();
    assert_eq!(
        (absent.cache_write_tokens, absent.cache_read_tokens),
        (0, 0)
    );
    let mut response: Value = serde_json::from_str(&message("end_turn", &text)).unwrap();
    response["usage"]["cache_creation_input_tokens"] = json!(1_000_000);
    response["usage"]["cache_read_input_tokens"] = json!(2_000_000);
    let parsed = parse_message(&response.to_string()).unwrap();
    assert_eq!(
        (
            parsed.input_tokens,
            parsed.cache_write_tokens,
            parsed.cache_read_tokens
        ),
        (1200, 1_000_000, 2_000_000)
    );
    response["stop_reason"] = json!("refusal");
    let refused = parse_message(&response.to_string()).unwrap();
    assert_eq!(
        (refused.cache_write_tokens, refused.cache_read_tokens),
        (1_000_000, 2_000_000)
    );
    assert!((cost_usd(HAIKU, 1_000_000, 1_000_000, 1_000_000, 2_000_000) - 0.745).abs() < 1e-9);
    assert!((cost_usd(SONNET, 1_000_000, 1_000_000, 1_000_000, 2_000_000) - 14.9).abs() < 1e-9);
    let e = env();
    s36(&e, "candidate", "recommended");
    let pair = e.f.library.claude_build_queue().unwrap().remove(0);
    e.f.library
        .claude_store_opinion(&pair, HAIKU, &parsed)
        .unwrap();
    e.f.library
        .claude_store_opinion(&pair, SONNET, &parsed)
        .unwrap();
    let c = e.f.library.connection().unwrap();
    assert_eq!(
        load_opinion(
            &c,
            &pair.target_id,
            &pair.asset_hash,
            &pair.reference_key,
            HAIKU
        )
        .unwrap(),
        Some(parsed.clone())
    );
    let expected = cost_usd(HAIKU, 1200, 80, 1_000_000, 2_000_000)
        + cost_usd(SONNET, 1200, 80, 1_000_000, 2_000_000);
    assert!((spend_usd(&c, &month_start(Local::now())).unwrap() - expected).abs() < 1e-9);
}
