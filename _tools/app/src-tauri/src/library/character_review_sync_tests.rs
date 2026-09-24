//! Receive and apply of mobile character-review decisions, and their place in the character
//! publication order (exclusions → review decisions → snapshot → feed).
use rusqlite::params;
use sha2::{Digest, Sha256};

use super::*;
use crate::library::characters::tests::Fixture;
use crate::library::characters::Target;
use crate::library::collection_personal_edits::tests::{configure, scripted};

const ENDPOINT: &str = "https://sync.example.test";

fn hash(id: &str) -> String {
    Sha256::digest(id.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn entry(
    sequence: i64,
    target: &str,
    asset: &str,
    decision: &str,
    basis: Option<&str>,
) -> ReviewDecisionEntry {
    ReviewDecisionEntry {
        sequence,
        operation_id: format!("op-{sequence}"),
        target_id: target.into(),
        asset_id: asset.into(),
        decision: decision.into(),
        origin: "feed".into(),
        basis: basis.map(str::to_owned),
        asset_sha256: hash(asset),
        created_at: "2026-09-24T00:00:00Z".into(),
    }
}

fn adopt(f: &Fixture, endpoint: &str) -> String {
    let id = f.library.library_id().unwrap();
    f.library
        .adopt_character_review_library(endpoint, &id)
        .unwrap();
    id
}

fn latest(f: &Fixture, target: &Target, asset: &str) -> Option<(i64, String, String)> {
    f.library
        .connection()
        .unwrap()
        .query_row(
            "SELECT sequence, decision, origin FROM character_decisions
             WHERE target_id=?1 AND source_asset_id=?2 ORDER BY sequence DESC LIMIT 1",
            params![target.id, asset],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .unwrap()
}

fn decision_count(f: &Fixture) -> i64 {
    f.library
        .connection()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM character_decisions", [], |r| r.get(0))
        .unwrap()
}

fn cursor(f: &Fixture, endpoint: &str) -> i64 {
    f.library
        .character_review_adoption(endpoint)
        .unwrap()
        .unwrap()
        .1
}

fn receipts(f: &Fixture) -> Vec<(i64, String, Option<i64>)> {
    f.library
        .connection()
        .unwrap()
        .prepare("SELECT sequence, outcome, decision_sequence FROM mobile_character_review_receipts ORDER BY sequence")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn mark_published(f: &Fixture) {
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE mobile_publication_state SET published_generation=generation",
            [],
        )
        .unwrap();
}

fn characters_dirty(f: &Fixture) -> bool {
    f.library
        .connection()
        .unwrap()
        .query_row(
            "SELECT generation>published_generation FROM mobile_publication_state WHERE kind='characters'",
            [],
            |r| r.get(0),
        )
        .unwrap()
}

fn manual(f: &Fixture, target: &Target, asset: &str, decision: DecisionKind) -> i64 {
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
    latest(f, target, asset).unwrap().0
}

#[test]
fn applies_accepted_rejected_and_same_channel_undo_with_receipts_and_cursor() {
    let f = Fixture::new();
    let target = f.ready("Review");
    let id = adopt(&f, ENDPOINT);
    mark_published(&f);
    let outcome = f
        .library
        .apply_character_review_page(
            ENDPOINT,
            &id,
            &[
                entry(1, &target.id, "asset-5", "accepted", Some("0")),
                // Outside the series folder: an inbound rejection still holds.
                entry(2, &target.id, "asset-6", "rejected", Some("0")),
                // The mobile undo of entry 1 clears the decision this channel wrote.
                entry(3, &target.id, "asset-5", "cleared", None),
            ],
        )
        .unwrap();
    assert_eq!(outcome.changed, 3);
    assert_eq!(latest(&f, &target, "asset-5").unwrap().1, "cleared");
    assert_eq!(latest(&f, &target, "asset-6").unwrap().1, "rejected");
    assert_eq!(latest(&f, &target, "asset-6").unwrap().2, "manual");
    assert_eq!(cursor(&f, ENDPOINT), 3);
    let recorded = receipts(&f);
    assert!(recorded
        .iter()
        .all(|(_, outcome, written)| outcome == "applied" && written.is_some()));
    assert!(characters_dirty(&f), "publication must follow");
    assert_eq!(
        f.library.character_review_inbound_status().unwrap().applied,
        3
    );
}

#[test]
fn decisions_apply_after_the_references_changed() {
    let f = Fixture::new();
    let target = f.ready("Review");
    let id = adopt(&f, ENDPOINT);
    // The character's references changed after the feed was published.
    let changed = f
        .library
        .exclude_character_reference(&target.id, target.revision, "asset-0")
        .unwrap();
    assert_ne!(changed.fingerprint, target.fingerprint);
    f.library
        .apply_character_review_page(
            ENDPOINT,
            &id,
            &[entry(1, &target.id, "asset-5", "accepted", Some("0"))],
        )
        .unwrap();
    assert_eq!(latest(&f, &target, "asset-5").unwrap().1, "accepted");
    let fingerprint: String = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT target_fingerprint FROM character_decisions ORDER BY sequence DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        fingerprint, changed.fingerprint,
        "recorded against the current fingerprint"
    );
}

#[test]
fn a_newer_independent_decision_supersedes_a_stale_mobile_judgment() {
    let f = Fixture::new();
    let target = f.ready("Review");
    let id = adopt(&f, ENDPOINT);
    // The feed was published with basis "0"; the PC user then rejected the pair.
    let pc = manual(&f, &target, "asset-5", DecisionKind::Rejected);
    let outcome = f
        .library
        .apply_character_review_page(
            ENDPOINT,
            &id,
            &[entry(1, &target.id, "asset-5", "accepted", Some("0"))],
        )
        .unwrap();
    assert_eq!(outcome.superseded, 1);
    assert_eq!(
        latest(&f, &target, "asset-5").unwrap(),
        (pc, "rejected".into(), "manual".into())
    );
    // A judgment made on a feed that already showed that decision applies.
    f.library
        .apply_character_review_page(
            ENDPOINT,
            &id,
            &[entry(
                2,
                &target.id,
                "asset-5",
                "accepted",
                Some(&pc.to_string()),
            )],
        )
        .unwrap();
    assert_eq!(latest(&f, &target, "asset-5").unwrap().1, "accepted");
    assert_eq!(receipts(&f)[0].1, "superseded");
    assert_eq!(receipts(&f)[1].1, "applied");
    // A decision this channel wrote never supersedes the channel's own later entry.
    f.library
        .apply_character_review_page(
            ENDPOINT,
            &id,
            &[entry(3, &target.id, "asset-5", "rejected", Some("0"))],
        )
        .unwrap();
    assert_eq!(latest(&f, &target, "asset-5").unwrap().1, "rejected");
    assert_eq!(cursor(&f, ENDPOINT), 3);
}

/// One more image in the series folder, so several pairs can be judged manually.
fn series_asset(f: &Fixture, id: &str) {
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
}

#[test]
fn a_mobile_undo_never_clears_an_older_independent_decision() {
    let f = Fixture::new();
    let target = f.ready("Review");
    series_asset(&f, "asset-8");
    series_asset(&f, "asset-9");
    let id = adopt(&f, ENDPOINT);
    // An older manual acceptance the feed already reflected (basis = its sequence).
    let pc = manual(&f, &target, "asset-5", DecisionKind::Accepted);
    let before = decision_count(&f);
    let outcome = f
        .library
        .apply_character_review_page(
            ENDPOINT,
            &id,
            &[
                // "맞음" on an already accepted pair writes nothing ...
                entry(1, &target.id, "asset-5", "accepted", Some(&pc.to_string())),
                // ... so its undo must not clear the PC's own acceptance.
                entry(2, &target.id, "asset-5", "cleared", None),
            ],
        )
        .unwrap();
    assert_eq!(
        (outcome.unchanged, outcome.superseded, outcome.changed),
        (1, 1, 0)
    );
    assert_eq!(decision_count(&f), before);
    assert_eq!(
        latest(&f, &target, "asset-5").unwrap(),
        (pc, "accepted".into(), "manual".into())
    );
    // Same for an older independent rejection with no channel decision at all.
    let rejected = manual(&f, &target, "asset-8", DecisionKind::Rejected);
    f.library
        .apply_character_review_page(
            ENDPOINT,
            &id,
            &[entry(3, &target.id, "asset-8", "cleared", None)],
        )
        .unwrap();
    assert_eq!(latest(&f, &target, "asset-8").unwrap().0, rejected);
    // A channel acceptance later changed on the PC: the undo leaves the PC change alone.
    f.library
        .apply_character_review_page(
            ENDPOINT,
            &id,
            &[entry(4, &target.id, "asset-9", "accepted", Some("0"))],
        )
        .unwrap();
    assert_eq!(latest(&f, &target, "asset-9").unwrap().1, "accepted");
    let pc_again = manual(&f, &target, "asset-9", DecisionKind::Rejected);
    f.library
        .apply_character_review_page(
            ENDPOINT,
            &id,
            &[entry(5, &target.id, "asset-9", "cleared", None)],
        )
        .unwrap();
    assert_eq!(latest(&f, &target, "asset-9").unwrap().0, pc_again);
    assert_eq!(
        receipts(&f).into_iter().map(|r| r.1).collect::<Vec<_>>(),
        [
            "applied",
            "superseded",
            "superseded",
            "applied",
            "superseded"
        ]
    );
}

#[test]
fn deterministic_failures_are_skipped_and_the_cursor_still_advances() {
    let f = Fixture::new();
    let target = f.ready("Review");
    let id = adopt(&f, ENDPOINT);
    let mut changed = entry(3, &target.id, "asset-5", "accepted", Some("0"));
    changed.asset_sha256 = hash("other bytes");
    mark_published(&f);
    let before = decision_count(&f);
    let outcome = f
        .library
        .apply_character_review_page(
            ENDPOINT,
            &id,
            &[
                entry(1, "missing-target", "asset-5", "accepted", Some("0")),
                entry(2, &target.id, "missing-asset", "rejected", Some("0")),
                changed,
                entry(4, &target.id, "asset-0", "rejected", Some("0")),
                // Accept outside the series folder fails eligibility.
                entry(5, &target.id, "asset-6", "accepted", Some("0")),
            ],
        )
        .unwrap();
    assert_eq!(outcome.skipped, 5);
    assert_eq!(decision_count(&f), before, "nothing written");
    assert_eq!(cursor(&f, ENDPOINT), 5);
    assert_eq!(
        receipts(&f).into_iter().map(|r| r.1).collect::<Vec<_>>(),
        [
            "skipped:targetMissing",
            "skipped:assetMissing",
            "skipped:assetChanged",
            "skipped:protectedReference",
            "skipped:ineligible"
        ]
    );
    assert!(
        characters_dirty(&f),
        "the new cursor still needs acknowledging"
    );
}

#[test]
fn replays_are_no_ops_and_gaps_or_conflicts_hold_the_cursor() {
    let f = Fixture::new();
    let target = f.ready("Review");
    let id = adopt(&f, ENDPOINT);
    let first = [
        entry(1, &target.id, "asset-5", "accepted", Some("0")),
        entry(2, &target.id, "asset-6", "rejected", Some("0")),
    ];
    f.library
        .apply_character_review_page(ENDPOINT, &id, &first)
        .unwrap();
    // The PC later clears the pair itself; a replayed page must not redo the acceptance.
    manual(&f, &target, "asset-5", DecisionKind::Cleared);
    mark_published(&f);
    let replay = f
        .library
        .apply_character_review_page(ENDPOINT, &id, &first)
        .unwrap();
    assert_eq!(replay.already_consumed, 2);
    assert_eq!(latest(&f, &target, "asset-5").unwrap().1, "cleared");
    assert!(!characters_dirty(&f), "a replay schedules nothing");
    // Gap.
    assert!(matches!(
        f.library.apply_character_review_page(
            ENDPOINT,
            &id,
            &[entry(4, &target.id, "asset-5", "accepted", None)]
        ),
        Err(LibraryError::CharacterReviewInvalid)
    ));
    // Same operation id, other content.
    let mut forged = entry(1, &target.id, "asset-5", "rejected", Some("0"));
    forged.operation_id = "op-1".into();
    assert!(matches!(
        f.library
            .apply_character_review_page(ENDPOINT, &id, &[forged]),
        Err(LibraryError::CharacterReviewInvalid)
    ));
    // Below the cursor without a receipt.
    let mut unknown = entry(2, &target.id, "asset-6", "rejected", Some("0"));
    unknown.operation_id = "never-seen".into();
    assert!(matches!(
        f.library
            .apply_character_review_page(ENDPOINT, &id, &[unknown]),
        Err(LibraryError::CharacterReviewInvalid)
    ));
    // A partial page with a gap rolls back entirely.
    let before = decision_count(&f);
    assert!(f
        .library
        .apply_character_review_page(
            ENDPOINT,
            &id,
            &[
                entry(3, &target.id, "asset-5", "rejected", Some("0")),
                entry(5, &target.id, "asset-5", "accepted", None)
            ],
        )
        .is_err());
    assert_eq!(decision_count(&f), before);
    assert_eq!(cursor(&f, ENDPOINT), 2);
    // Another library identity is refused.
    assert!(matches!(
        f.library
            .apply_character_review_page(ENDPOINT, "fedcba9876543210fedcba9876543210", &[]),
        Err(LibraryError::CharacterReviewCursorRejected)
    ));
}

#[test]
fn page_validation_rejects_non_contiguous_or_malformed_shapes() {
    let id = "0123456789abcdef0123456789abcdef";
    let page =
        |after: i64, next: i64, more: bool, items: Vec<ReviewDecisionEntry>| ReviewDecisionPage {
            version: 1,
            library_id: id.into(),
            after,
            next_cursor: next,
            has_more: more,
            items,
        };
    let ok = entry(1, "t", "a", "accepted", Some("0"));
    assert!(validate_page(&page(0, 1, false, vec![ok.clone()]), id, 0, 100).is_ok());
    assert!(validate_page(&page(0, 0, false, vec![]), id, 0, 100).is_ok());
    let mut bad_decision = ok.clone();
    bad_decision.decision = "maybe".into();
    let mut bad_origin = ok.clone();
    bad_origin.origin = "pc".into();
    let mut bad_hash = ok.clone();
    bad_hash.asset_sha256 = "x".into();
    let mut bad_id = ok.clone();
    bad_id.target_id = "a/b".into();
    for bad in [
        page(0, 2, false, vec![ok.clone()]),
        page(0, 0, true, vec![]),
        page(1, 1, false, vec![ok.clone()]),
        page(0, 1, false, vec![bad_decision]),
        page(0, 1, false, vec![bad_origin]),
        page(0, 1, false, vec![bad_hash]),
        page(0, 1, false, vec![bad_id]),
    ] {
        let after = bad.after;
        assert!(matches!(
            validate_page(&bad, id, after.min(0), 100),
            Err(LibraryError::CharacterReviewInvalid)
        ));
    }
    assert!(validate_page(
        &page(0, 1, false, vec![ok]),
        "fedcba9876543210fedcba9876543210",
        0,
        100
    )
    .is_err());
}

#[test]
fn the_receive_poll_runs_at_most_once_a_minute() {
    let f = Fixture::new();
    assert!(f.library.claim_character_review_poll(ENDPOINT).unwrap());
    assert!(!f.library.claim_character_review_poll(ENDPOINT).unwrap());
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE mobile_character_review_poll SET last_checked=unixepoch()-61",
            [],
        )
        .unwrap();
    assert!(f.library.claim_character_review_poll(ENDPOINT).unwrap());
}

// --- Scripted server: publication order, navigation cursor, fallback --------------------

fn page_json(library_id: &str, after: i64, next: i64, items: &[ReviewDecisionEntry]) -> String {
    serde_json::json!({
        "version": 1, "libraryId": library_id, "after": after, "nextCursor": next,
        "hasMore": false, "items": items,
    })
    .to_string()
}

fn exclusion_page(library_id: &str) -> String {
    format!(
        r#"{{"version":1,"libraryId":"{library_id}","after":0,"nextCursor":0,"hasMore":false,"items":[]}}"#
    )
}

const INDEX: &str = r#"{"version":1,"authority":"pc","authorityEpoch":0,"revision":null}"#;
const PUBLISHED: &str = r#"{"revision":"r1","nodes":1}"#;

fn feed_receipt() -> String {
    format!(
        r#"{{"version":1,"revision":"{}","items":0,"dropped":0}}"#,
        "a".repeat(64)
    )
}

/// Enable sync for the scripted server and adopt manual exclusions on it.
fn bind(f: &Fixture, base: &str) -> String {
    configure(&f.library, base);
    let id = f.library.library_id().unwrap();
    f.library
        .adopt_character_exclusion_library(base, &id)
        .unwrap();
    id
}

#[test]
fn review_decisions_are_received_before_the_snapshot_which_carries_their_cursor() {
    let f = Fixture::new();
    let target = f.ready("Review");
    let id = f.library.library_id().unwrap();
    let decision = entry(1, &target.id, "asset-5", "accepted", Some("0"));
    let (base, handle) = scripted(vec![
        (
            "/v1/library/characters/exclusions?",
            200,
            exclusion_page(&id),
        ),
        (
            "/v1/library/characters/review/decisions?",
            200,
            page_json(&id, 0, 0, &[]),
        ),
        (
            "/v1/library/characters/review/decisions?",
            200,
            page_json(&id, 0, 1, &[decision]),
        ),
        ("/v1/library/characters", 200, INDEX.into()),
        ("/v1/library/characters/replica", 200, PUBLISHED.into()),
        ("/v1/library/characters/review/feed", 200, feed_receipt()),
    ]);
    bind(&f, &base);
    let client = CloudClient::new(&base).unwrap();
    f.library
        .push_cloud_characters_with(
            &client,
            &base,
            "shared",
            Some("publisher"),
            Some(&Default::default()),
            &|_| {},
        )
        .unwrap();
    let seen = handle.join().unwrap();
    assert!(seen[1].0.contains("after=0&limit=1"), "probe");
    assert!(seen[2].0.contains("after=0&limit=100"), "receive");
    assert_eq!(seen[1].1.as_deref(), Some("Bearer publisher"));
    let snapshot: serde_json::Value = serde_json::from_str(&seen[4].2).unwrap();
    assert_eq!(snapshot["reviewDecisionCursor"], 1);
    assert_eq!(snapshot["manualExclusionVersion"], 1);
    let scope = snapshot["scopes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["nodeId"] == format!("character:{}", target.id) && s["filter"] == "all")
        .unwrap();
    assert!(
        scope["assetIds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a == "asset-5"),
        "the snapshot reflects the decision it acknowledges"
    );
    let feed: serde_json::Value = serde_json::from_str(&seen[5].2).unwrap();
    assert_eq!(
        feed["decisionCursor"], 1,
        "the feed carries the acknowledged position"
    );
    assert_eq!(feed["baseRevision"], serde_json::Value::Null);
    assert_eq!(seen[5].1.as_deref(), Some("Bearer publisher"));
    let adopted: (i64, i64) = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT s.acknowledged_cursor, f.adopted FROM mobile_character_review_sync s
             JOIN mobile_character_review_feed_state f USING(endpoint, library_id)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(adopted, (1, 1));
}

#[test]
fn an_older_server_keeps_the_snapshot_without_the_review_cursor() {
    let f = Fixture::new();
    f.ready("Review");
    let id = f.library.library_id().unwrap();
    let unsupported = r#"{"detail":{"code":"characterReviewUnsupported","message":"x"}}"#;
    let (base, handle) = scripted(vec![
        // Old server: no review route at all.
        (
            "/v1/library/characters/exclusions?",
            200,
            exclusion_page(&id),
        ),
        (
            "/v1/library/characters/review/decisions?",
            404,
            String::new(),
        ),
        ("/v1/library/characters", 200, INDEX.into()),
        ("/v1/library/characters/replica", 200, PUBLISHED.into()),
        // New server whose library is not linked yet.
        (
            "/v1/library/characters/exclusions?",
            200,
            exclusion_page(&id),
        ),
        (
            "/v1/library/characters/review/decisions?",
            409,
            unsupported.into(),
        ),
        ("/v1/library/characters", 200, INDEX.into()),
        ("/v1/library/characters/replica", 200, PUBLISHED.into()),
    ]);
    bind(&f, &base);
    let client = CloudClient::new(&base).unwrap();
    for _ in 0..2 {
        f.library
            .push_cloud_characters_with(&client, &base, "shared", Some("publisher"), None, &|_| {})
            .unwrap();
    }
    let seen = handle.join().unwrap();
    for index in [3, 7] {
        let snapshot: serde_json::Value = serde_json::from_str(&seen[index].2).unwrap();
        assert!(snapshot.get("reviewDecisionCursor").is_none());
        assert_eq!(snapshot["manualExclusionVersion"], 1);
    }
    assert_eq!(f.library.character_review_adoption(&base).unwrap(), None);
}

#[test]
fn before_adoption_the_snapshot_carries_a_zero_cursor_and_a_refused_feed_is_retried_later() {
    let f = Fixture::new();
    f.ready("Review");
    let id = f.library.library_id().unwrap();
    let unsupported = r#"{"detail":{"code":"characterReviewUnsupported","message":"x"}}"#;
    let (base, handle) = scripted(vec![
        (
            "/v1/library/characters/exclusions?",
            200,
            exclusion_page(&id),
        ),
        (
            "/v1/library/characters/review/decisions?",
            200,
            page_json(&id, 0, 0, &[]),
        ),
        (
            "/v1/library/characters/review/decisions?",
            200,
            page_json(&id, 0, 0, &[]),
        ),
        ("/v1/library/characters", 200, INDEX.into()),
        ("/v1/library/characters/replica", 200, PUBLISHED.into()),
        (
            "/v1/library/characters/review/feed",
            409,
            unsupported.into(),
        ),
    ]);
    bind(&f, &base);
    let client = CloudClient::new(&base).unwrap();
    f.library
        .push_cloud_characters_with(&client, &base, "shared", Some("publisher"), None, &|_| {})
        .expect("a refused feed never fails the character publication");
    let seen = handle.join().unwrap();
    let snapshot: serde_json::Value = serde_json::from_str(&seen[4].2).unwrap();
    assert_eq!(snapshot["reviewDecisionCursor"], 0);
    let (adopted, retry): (i64, bool) = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT adopted, retry_after>unixepoch()+200 FROM mobile_character_review_feed_state",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((adopted, retry), (0, true));
}
