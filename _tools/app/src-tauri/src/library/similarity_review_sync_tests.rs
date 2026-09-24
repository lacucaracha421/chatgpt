//! Mobile similarity review on the PC: export filter and shape, adoption and fallback,
//! applying each decision (trash + lifecycle outbox), crash re-delivery, skip outcomes,
//! withdrawn look-ahead, and automatic comparison of newly materialized Assets.
use image::{DynamicImage, ImageBuffer};
use rusqlite::params;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

use super::*;
use crate::cloud::similarity_review::{DecisionBasis, DecisionEntry};
use crate::library::asset_authority::MaterializationIdentity;
use crate::library::collection_personal_edits::tests::{configure, scripted};
use crate::library::models::{ImportSource, IngestMediaRequest, IngestOutcome};

const ENDPOINT: &str = "https://sync.example.test";

fn sha(value: impl AsRef<[u8]>) -> String {
    Sha256::digest(value)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

struct F {
    temp: TempDir,
    library: Library,
    id: String,
}

fn fixture() -> F {
    let temp = TempDir::new().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let id = library.library_id().unwrap();
    library
        .connection()
        .unwrap()
        .execute("INSERT INTO asset_authority VALUES(1,?1,1,1,0)", [&id])
        .unwrap();
    F { temp, library, id }
}

fn projection(id: &str, lifecycle: &str, sha256: &str, size: u64) -> String {
    serde_json::json!({
        "assetId": id, "lifecycle": lifecycle, "entityRevision": 1, "sha256": sha256,
        "sizeBytes": size, "contentType": "image/png", "createdAt": "2026-09-20T00:00:00Z",
        "updatedAt": "2026-09-20T00:00:00Z"
    })
    .to_string()
}

/// A local Asset; `authority` is its canonical lifecycle (`None`: the server never saw it).
fn asset(f: &F, id: &str, status: &str, source: Option<&str>, authority: Option<&str>) {
    let c = f.library.connection().unwrap();
    c.execute(
        "INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,
            byte_size,width,height,collected_at,status,source_url)
         VALUES(?1,?2,'image',?1,?3,?4,1234,100,80,'2026-09-20T10:00:00Z',?5,?6)",
        params![id, sha(id), format!("assets/{id}.png"), format!("thumbnails/{id}.webp"), status, source],
    )
    .unwrap();
    if let Some(lifecycle) = authority {
        c.execute(
            "INSERT INTO asset_authority_state(asset_id,lifecycle,entity_revision,sha256,size_bytes,projection,materialization)
             VALUES(?1,?2,1,?3,1234,?4,'complete')",
            params![id, lifecycle, sha(id), projection(id, lifecycle, &sha(id), 1234)],
        )
        .unwrap();
    }
}

fn review(f: &F, id: &str, a: &str, b: &str, kind: &str, status: &str, created: u32) {
    let decision = (status == "resolved").then_some("keep_both");
    let resolved = (status == "resolved").then_some("2026-09-22T00:00:00Z");
    f.library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO similarity_reviews(id,existing_asset_id,candidate_asset_id,distance,fingerprint_kind,
                review_kind,status,decision,created_at,resolved_at)
             VALUES(?1,?2,?3,4,'pdq-v1',?4,?5,?6,?7,?8)",
            params![
                id,
                a,
                b,
                kind,
                status,
                decision,
                format!("2026-09-21T00:00:{created:02}Z"),
                resolved
            ],
        )
        .unwrap();
}

fn eligible(f: &F, ids: &[&str]) {
    for id in ids {
        asset(f, id, "normal", None, Some("normal"));
    }
}

fn entry(sequence: i64, review: &str, decision: &str, a: &str, b: &str) -> DecisionEntry {
    DecisionEntry {
        sequence,
        operation_id: format!("00000000-0000-4000-8000-{sequence:012}"),
        review_id: review.into(),
        decision: decision.into(),
        a_asset_id: a.into(),
        b_asset_id: b.into(),
        trash_asset_id: match decision {
            "keep_existing" => Some(b.into()),
            "replace_existing" => Some(a.into()),
            _ => None,
        },
        withdraws: None,
        basis: DecisionBasis {
            feed_revision: "f".repeat(64),
            a_sha256: sha(a),
            b_sha256: sha(b),
        },
        created_at: "2026-09-24T00:00:00Z".into(),
    }
}

fn status(f: &F, id: &str) -> String {
    f.library
        .connection()
        .unwrap()
        .query_row("SELECT status FROM assets WHERE id=?1", [id], |r| r.get(0))
        .unwrap()
}

fn outbox(f: &F) -> Vec<(String, String)> {
    f.library
        .connection()
        .unwrap()
        .prepare("SELECT asset_id, desired FROM asset_lifecycle_outbox ORDER BY sequence")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn receipts(f: &F) -> Vec<(i64, String)> {
    f.library
        .connection()
        .unwrap()
        .prepare(
            "SELECT sequence, outcome FROM mobile_similarity_review_receipts ORDER BY sequence",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn cursor(f: &F) -> i64 {
    f.library
        .similarity_review_adoption(ENDPOINT)
        .unwrap()
        .unwrap()
        .1
}

fn review_state(f: &F, id: &str) -> (String, Option<String>) {
    f.library
        .connection()
        .unwrap()
        .query_row(
            "SELECT status, decision FROM similarity_reviews WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
}

#[test]
fn export_lists_open_historical_pairs_of_normal_assets_with_a_known_sha256() {
    let f = fixture();
    asset(
        &f,
        "a",
        "normal",
        Some("https://x.com/artist/status/1?s=20"),
        Some("normal"),
    );
    eligible(&f, &["b", "c", "i"]);
    asset(&f, "d", "normal", None, None); // never reached the server
    asset(&f, "e", "normal", None, Some("trash")); // trashed on the server
    asset(&f, "g", "normal", None, Some("normal"));
    asset(&f, "h", "review", None, Some("normal")); // an incoming candidate
    {
        let c = f.library.connection().unwrap();
        // The server holds other bytes for g.
        c.execute(
            "UPDATE asset_authority_state SET sha256=?1 WHERE asset_id='g'",
            [sha("other")],
        )
        .unwrap();
        c.execute_batch(
            "INSERT INTO classification_entries(id,kind,name,created_at) VALUES('t1','tag','원본','2026');
             INSERT INTO asset_classifications(asset_id,classification_id) VALUES('a','t1');",
        )
        .unwrap();
    }
    review(&f, "r1", "a", "b", "historical", "open", 1);
    review(&f, "r2", "c", "a", "historical", "open", 2);
    review(&f, "r3", "b", "c", "historical", "open", 3);
    review(&f, "r4", "a", "d", "historical", "open", 4);
    review(&f, "r5", "a", "e", "historical", "open", 5);
    review(&f, "r6", "a", "g", "historical", "open", 6);
    review(&f, "r7", "a", "h", "incoming", "open", 7);
    review(&f, "r8", "b", "i", "historical", "resolved", 8);
    review(&f, "r9", "c", "i", "historical", "stale", 9);

    let items = f.library.similarity_review_feed_items().unwrap();
    let ids: Vec<_> = items.iter().map(|i| i.review_id.as_str()).collect();
    assert_eq!(ids, ["r1", "r2", "r3"]);
    // Recommendation: the side with provenance; a → keep_existing, b → replace_existing.
    let recommended: Vec<_> = items
        .iter()
        .map(|i| {
            (
                i.recommended_asset_id.as_deref(),
                i.recommendation.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        recommended,
        [
            (Some("a"), Some("keep_existing")),
            (Some("a"), Some("replace_existing")),
            (None, None)
        ]
    );
    let value = serde_json::to_value(&items[0]).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "reviewId": "r1", "kind": "historical", "distance": 4,
            "recommendedAssetId": "a", "recommendation": "keep_existing",
            "a": {"assetId": "a", "sha256": sha("a"), "width": 100, "height": 80, "byteSize": 1234,
                  "format": "PNG", "sourceLabel": "x.com/artist/status/1",
                  "collectedAt": "2026-09-20T10:00:00Z", "classifications": ["원본"]},
            "b": {"assetId": "b", "sha256": sha("b"), "width": 100, "height": 80, "byteSize": 1234,
                  "format": "PNG", "sourceLabel": null,
                  "collectedAt": "2026-09-20T10:00:00Z", "classifications": []}
        })
    );
    // No local paths ever leave the PC.
    let text = serde_json::to_string(&items).unwrap();
    assert!(!text.contains("assets/") && !text.contains("thumbnails/"));
}

#[test]
fn each_decision_moves_the_right_image_to_trash_and_queues_its_lifecycle_command() {
    for (decision, trashed) in [
        ("keep_existing", Some("b")),
        ("replace_existing", Some("a")),
        ("keep_both", None),
    ] {
        let f = fixture();
        eligible(&f, &["a", "b"]);
        review(&f, "r1", "a", "b", "historical", "open", 1);
        f.library
            .adopt_similarity_review_library(ENDPOINT, &f.id)
            .unwrap();
        let outcome = f
            .library
            .apply_similarity_review_page(ENDPOINT, &f.id, &[entry(1, "r1", decision, "a", "b")])
            .unwrap();
        assert_eq!(outcome.applied, 1, "{decision}");
        assert_eq!(
            review_state(&f, "r1"),
            ("resolved".into(), Some(decision.into()))
        );
        for id in ["a", "b"] {
            let expected = if Some(id) == trashed {
                "trash"
            } else {
                "normal"
            };
            assert_eq!(status(&f, id), expected, "{decision}: {id}");
        }
        assert_eq!(
            outbox(&f),
            trashed
                .map(|id| vec![(id.to_string(), "trash".to_string())])
                .unwrap_or_default(),
            "{decision}"
        );
        assert_eq!(receipts(&f), [(1, "applied".to_string())]);
        assert_eq!(cursor(&f), 1);
        assert_eq!(
            f.library
                .similarity_review_inbound_status()
                .unwrap()
                .applied,
            1
        );
    }
}

#[test]
fn a_redelivery_after_a_crash_before_the_receipt_records_applied_once() {
    let f = fixture();
    eligible(&f, &["a", "b"]);
    review(&f, "r1", "a", "b", "historical", "open", 1);
    f.library
        .adopt_similarity_review_library(ENDPOINT, &f.id)
        .unwrap();
    // The decision landed, then the process died before the receipt was written.
    f.library
        .decide_similarity_review(SimilarityDecisionRequest {
            review_id: "r1".into(),
            decision: SimilarityDecision::KeepExisting,
        })
        .unwrap();
    let page = [entry(1, "r1", "keep_existing", "a", "b")];
    let outcome = f
        .library
        .apply_similarity_review_page(ENDPOINT, &f.id, &page)
        .unwrap();
    assert_eq!(outcome.applied, 1);
    assert_eq!(receipts(&f), [(1, "applied".to_string())]);
    assert_eq!(outbox(&f), [("b".to_string(), "trash".to_string())]);
    // A replayed page is a no-op.
    let again = f
        .library
        .apply_similarity_review_page(ENDPOINT, &f.id, &page)
        .unwrap();
    assert_eq!(again.already_consumed, 1);
    assert_eq!(outbox(&f).len(), 1);
    assert_eq!(cursor(&f), 1);
    // The same operation id with other content is a divergence.
    let mut forged = page[0].clone();
    forged.decision = "keep_both".into();
    forged.trash_asset_id = None;
    assert!(f
        .library
        .apply_similarity_review_page(ENDPOINT, &f.id, &[forged])
        .is_err());
}

#[test]
fn skipped_decisions_advance_the_cursor_and_are_reported_by_the_next_feed() {
    let f = fixture();
    eligible(&f, &["a", "b", "c", "d", "e", "g", "h", "i", "j", "k"]);
    review(&f, "r1", "a", "b", "historical", "open", 1);
    review(&f, "r2", "c", "d", "historical", "open", 2);
    review(&f, "r3", "e", "g", "historical", "open", 3);
    review(&f, "r4", "h", "i", "historical", "open", 4);
    review(&f, "r5", "j", "k", "historical", "open", 5);
    // r1 was decided differently on the PC; d was trashed on the PC; i was deleted.
    f.library
        .decide_similarity_review(SimilarityDecisionRequest {
            review_id: "r1".into(),
            decision: SimilarityDecision::KeepBoth,
        })
        .unwrap();
    {
        let c = f.library.connection().unwrap();
        c.execute(
            "UPDATE assets SET status='trash', trashed_at='2026' WHERE id='d'",
            [],
        )
        .unwrap();
        c.execute("DELETE FROM asset_authority_state WHERE asset_id='i'", [])
            .unwrap();
        c.execute("DELETE FROM assets WHERE id='i'", []).unwrap();
    }
    let mut changed = entry(3, "r3", "keep_existing", "e", "g");
    changed.basis.a_sha256 = sha("edited");
    let page = [
        entry(1, "r1", "keep_existing", "a", "b"),
        entry(2, "r2", "keep_existing", "c", "d"),
        changed,
        entry(4, "r4", "replace_existing", "h", "i"),
        entry(5, "r5", "keep_both", "j", "k"),
    ];
    let (base, handle) = scripted(vec![(
        "/v1/library/similarity/review/feed",
        200,
        format!(
            r#"{{"version":1,"revision":"{}","items":0,"dropped":0}}"#,
            "a".repeat(64)
        ),
    )]);
    configure(&f.library, &base);
    f.library
        .adopt_similarity_review_library(&base, &f.id)
        .unwrap();
    let outcome = f
        .library
        .apply_similarity_review_page(&base, &f.id, &page)
        .unwrap();
    assert_eq!((outcome.applied, outcome.skipped), (1, 4));
    let recorded: Vec<(i64, String)> = receipts(&f);
    assert_eq!(
        recorded,
        [
            (1, "skipped:resolvedOnPc".to_string()),
            (2, "skipped:stale".to_string()),
            (3, "skipped:changed".to_string()),
            (4, "skipped:assetGone".to_string()),
            (5, "applied".to_string()),
        ]
    );
    assert_eq!(
        f.library
            .similarity_review_adoption(&base)
            .unwrap()
            .unwrap()
            .1,
        5
    );
    // Nothing was trashed by a skipped decision.
    for id in ["b", "e", "g", "h", "j", "k"] {
        assert_eq!(status(&f, id), "normal", "{id}");
    }
    assert_eq!(review_state(&f, "r3").0, "open");

    let client = CloudClient::new(&base).unwrap();
    let published = f
        .library
        .publish_due_similarity_review_feed_with(&client, "publisher", "shared", &base)
        .unwrap();
    assert_eq!(
        published,
        FeedOutcome::Published {
            revision: "a".repeat(64)
        }
    );
    let seen = handle.join().unwrap();
    assert_eq!(seen[0].1.as_deref(), Some("Bearer publisher"));
    let body: serde_json::Value = serde_json::from_str(&seen[0].2).unwrap();
    assert_eq!(body["baseRevision"], serde_json::Value::Null);
    assert_eq!(body["decisionCursor"], 5);
    assert_eq!(
        body["skipped"],
        serde_json::json!([
            {"sequence": 1, "reason": "resolvedOnPc"},
            {"sequence": 2, "reason": "stale"},
            {"sequence": 3, "reason": "changed"},
            {"sequence": 4, "reason": "assetGone"}
        ])
    );
    // Only the still-open pair is published (r3: its bytes did not change locally).
    let listed: Vec<_> = body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["reviewId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(listed, ["r3"]);
}

#[test]
fn a_decision_withdrawn_later_in_the_page_is_never_applied() {
    let f = fixture();
    eligible(&f, &["a", "b"]);
    review(&f, "r1", "a", "b", "historical", "open", 1);
    f.library
        .adopt_similarity_review_library(ENDPOINT, &f.id)
        .unwrap();
    let mut undo = entry(2, "r1", "withdrawn", "a", "b");
    undo.withdraws = Some(1);
    let outcome = f
        .library
        .apply_similarity_review_page(
            ENDPOINT,
            &f.id,
            &[entry(1, "r1", "keep_existing", "a", "b"), undo],
        )
        .unwrap();
    assert_eq!((outcome.applied, outcome.skipped), (1, 1));
    assert_eq!(
        receipts(&f),
        [
            (1, "skipped:withdrawn".to_string()),
            (2, "applied".to_string())
        ]
    );
    assert_eq!(review_state(&f, "r1"), ("open".into(), None));
    assert_eq!(
        (status(&f, "a"), status(&f, "b")),
        ("normal".into(), "normal".into())
    );
    assert!(outbox(&f).is_empty());
    assert_eq!(cursor(&f), 2);
    // Nothing was applied, so the desktop has nothing to reload.
    assert_eq!(
        f.library
            .similarity_review_inbound_status()
            .unwrap()
            .applied,
        0
    );
}

#[test]
fn adoption_probes_the_log_and_an_older_server_stays_off() {
    let f = fixture();
    eligible(&f, &["a", "b"]);
    review(&f, "r1", "a", "b", "historical", "open", 1);
    let empty = format!(
        r#"{{"version":1,"libraryId":"{}","after":0,"nextCursor":0,"hasMore":false,"items":[]}}"#,
        f.id
    );
    let unsupported = r#"{"detail":{"code":"similarityReviewUnsupported","message":"x"}}"#;
    let decisions = "/v1/library/similarity/review/decisions?libraryId=";
    let feed = "/v1/library/similarity/review/feed";
    let (base, handle) = scripted(vec![
        // An older server: no route.
        (decisions, 404, String::new()),
        // Server library not linked yet.
        (decisions, 409, unsupported.into()),
        // Ready: the probe binds the endpoint, then the first page is read.
        (decisions, 200, empty.clone()),
        (decisions, 200, empty),
        // First feed PUT adopts; a later server without the route is retried after 5 min.
        (
            feed,
            200,
            format!(r#"{{"version":1,"revision":"{}"}}"#, "b".repeat(64)),
        ),
        (feed, 404, String::new()),
    ]);
    configure(&f.library, &base);
    let client = CloudClient::new(&base).unwrap();
    let receive = || {
        f.library
            .receive_similarity_review_with(&client, "publisher", &base)
            .unwrap()
    };
    let publish = || {
        f.library
            .publish_due_similarity_review_feed_with(&client, "publisher", "shared", &base)
            .unwrap()
    };
    assert_eq!(receive(), None);
    assert_eq!(
        publish(),
        FeedOutcome::NotReady,
        "no feed before the endpoint is bound"
    );
    assert_eq!(receive(), None);
    assert_eq!(receive(), Some(0));
    assert_eq!(
        publish(),
        FeedOutcome::Published {
            revision: "b".repeat(64)
        }
    );
    assert_eq!(publish(), FeedOutcome::NotDue);
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE mobile_similarity_review_feed_state SET built_at=unixepoch()-301",
            [],
        )
        .unwrap();
    // Rebuilt after five minutes, but an unchanged body is not sent again.
    assert_eq!(publish(), FeedOutcome::Unchanged);
    f.library
        .connection()
        .unwrap()
        .execute(
            "UPDATE mobile_similarity_review_feed_state SET built_at=0, body_digest=NULL",
            [],
        )
        .unwrap();
    assert_eq!(publish(), FeedOutcome::Unsupported);
    assert_eq!(
        publish(),
        FeedOutcome::NotDue,
        "retried only after five minutes"
    );
    let seen = handle.join().unwrap();
    let adopted: serde_json::Value = serde_json::from_str(&seen[4].2).unwrap();
    assert_eq!(adopted["baseRevision"], serde_json::Value::Null);
    assert_eq!(adopted["libraryId"], f.id);
    assert_eq!(adopted["decisionCursor"], 0);
    assert_eq!(adopted["items"][0]["reviewId"], "r1");
    let retried: serde_json::Value = serde_json::from_str(&seen[5].2).unwrap();
    assert_eq!(retried["baseRevision"], "b".repeat(64));
}

// --- Automatic comparison of newly materialized Assets ---------------------------------

fn picture(width: u32, height: u32, vertical: bool) -> Vec<u8> {
    let image = DynamicImage::ImageRgb8(ImageBuffer::from_fn(width, height, |x, y| {
        let nx = x as f32 / width as f32;
        let ny = y as f32 / height as f32;
        let mut color = [
            (35.0 + nx * 90.0) as u8,
            (45.0 + ny * 100.0) as u8,
            (170.0 - nx * 55.0) as u8,
        ];
        let (along, across) = if vertical { (nx, ny) } else { (ny, nx) };
        if (0.18..0.43).contains(&along) && (0.12..0.88).contains(&across) {
            color = [235, 75, 35];
        }
        if (0.55..0.90).contains(&nx) && (0.08..0.20).contains(&ny) {
            color = [245, 205, 35];
        }
        if (nx - 0.72).powi(2) + (ny - 0.68).powi(2) < 0.085 {
            color = [25, 215, 135];
        }
        image::Rgb(color)
    }));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}

fn request(path: std::path::PathBuf) -> IngestMediaRequest {
    IngestMediaRequest {
        source_path: path,
        classification_id: None,
        source_url: None,
        collected_at: Some("2026-09-20T10:00:00Z".into()),
        replace_duplicate_metadata: false,
        source_published_at: None,
        creator_name: None,
        creator_handle: None,
        creator_url: None,
        import_source: ImportSource::BrowserExtension,
        import_batch_id: uuid::Uuid::new_v4().to_string(),
    }
}

/// Materialize a server-created Asset the way the asset authority sync does.
fn materialize(f: &F, id: &str, bytes: &[u8]) {
    let digest = sha(bytes);
    f.library
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO asset_authority_state(asset_id,lifecycle,entity_revision,sha256,size_bytes,projection)
             VALUES(?1,'normal',1,?2,?3,?4)",
            params![id, digest, bytes.len() as i64, projection(id, "normal", &digest, bytes.len() as u64)],
        )
        .unwrap();
    let path = f.temp.path().join(format!("{id}.png"));
    std::fs::write(&path, bytes).unwrap();
    f.library
        .ingest_media_with_identity(
            request(path),
            Some(&MaterializationIdentity {
                asset_id: id.into(),
                sha256: digest,
                size_bytes: bytes.len() as u64,
            }),
        )
        .unwrap();
}

fn queued(f: &F) -> Vec<String> {
    f.library
        .connection()
        .unwrap()
        .prepare("SELECT asset_id FROM similarity_auto_compare_queue ORDER BY asset_id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn automatic_comparison_pairs_a_materialized_near_duplicate_but_not_a_distinct_image() {
    let f = fixture();
    let original = f.temp.path().join("original.png");
    std::fs::write(&original, picture(900, 600, true)).unwrap();
    let IngestOutcome::Added { asset } = f.library.ingest_media(request(original)).unwrap() else {
        panic!("the original is a new Asset");
    };
    assert!(
        queued(&f).is_empty(),
        "a local import was already compared at ingestion"
    );

    // A mobile save of the same picture, smaller: skipped the ingestion check, queued instead.
    materialize(&f, "mobile-near", &picture(450, 300, true));
    assert_eq!(queued(&f), ["mobile-near"]);
    assert_eq!(f.library.run_similarity_auto_compare_batch().unwrap(), 1);
    assert!(queued(&f).is_empty());
    let pair: (String, String, String, String) = f
        .library
        .connection()
        .unwrap()
        .query_row(
            "SELECT existing_asset_id, candidate_asset_id, review_kind, status FROM similarity_reviews",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        pair,
        (
            asset.id.clone(),
            "mobile-near".into(),
            "historical".into(),
            "open".into()
        )
    );
    let listed = f.library.list_similarity_reviews(None, 20).unwrap();
    assert_eq!(listed.total_count, 1);
    assert!(listed.items[0].historical);

    // A different picture: compared, no pair.
    materialize(&f, "mobile-far", &picture(900, 600, false));
    assert_eq!(f.library.run_similarity_auto_compare_batch().unwrap(), 0);
    assert!(queued(&f).is_empty());
    // An empty queue does nothing.
    assert_eq!(f.library.run_similarity_auto_compare_batch().unwrap(), 0);
    let count: i64 = f
        .library
        .connection()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM similarity_reviews", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}
