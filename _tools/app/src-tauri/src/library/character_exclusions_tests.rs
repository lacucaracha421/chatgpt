//! Receive, validation and idempotency for mobile manual character exclusions.
//!
//! The fixture is deliberately built the same way `cloud::characters` builds its own, so a
//! correction accepted on mobile is applied to a library whose projection is produced by the
//! real publication query rather than by a stand-in.
use rusqlite::params;

use crate::cloud::characters::{validate_exclusion_page, ExclusionEntry, ExclusionPage};
use crate::library::{error::LibraryError, Library};

use super::*;

const ENDPOINT: &str = "https://sync.example.test";
const OTHER_LIBRARY: &str = "fedcba9876543210fedcba9876543210";

/// A series with one character target and three candidate assets.
///
/// `asset-x` is a learned reference of the target, `asset-b` lives outside the series
/// folder, and `asset-a` sits inside it — which is what lets the "protected", "moved out"
/// and "ordinary" cases be exercised against one fixture.
fn fixture() -> (tempfile::TempDir, Library) {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let c = library.connection().unwrap();
    c.execute_batch(
        "INSERT INTO classification_entries(id,kind,name,parent_id,created_at) VALUES ('r','root','Root',NULL,'2026'),('s','tag','Series','r','2026'),('other','tag','Other','r','2026');
         INSERT INTO character_series(classification_id,auto_classify) VALUES('s',0);
         INSERT INTO character_targets(id,series_classification_id,display_name,enabled,manual_only,created_at,updated_at) VALUES('c','s','C',1,0,'2026','2026');",
    )
    .unwrap();
    for (id, folder) in [("a", "s"), ("b", "other"), ("x", "s")] {
        // The stored `content_hash` is the 64-hex identity the wire also carries, so the
        // same-byte check is exercised against a realistic value rather than a short stub.
        c.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status) VALUES(?1,?3,'image',?1,?2,?2,1,1,1,'2026-09-13T00:00:00Z','normal')", params![id, format!("assets/{id}.png"), hex_hash(id)]).unwrap();
        c.execute(
            "INSERT INTO asset_classifications VALUES(?1,?2)",
            params![id, folder],
        )
        .unwrap();
    }
    // `x` is a base and a learned reference, so it is protected both ways.
    c.execute("INSERT INTO character_references VALUES('c',0,'x','x')", [])
        .unwrap();
    c.execute(
        "INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at) VALUES('c','x','x','2026')",
        [],
    )
    .unwrap();
    drop(c);
    (temp, library)
}

fn library_id(library: &Library) -> String {
    library.library_id().unwrap()
}

/// A deterministic 64-lowercase-hex content hash for an asset id.
///
/// The wire carries the hash as same-byte identity, so fixtures use a realistic value for the
/// same field the validation actually checks.
fn hex_hash(id: &str) -> String {
    let mut value = String::with_capacity(64);
    while value.len() < 64 {
        value.push_str(&format!("{:x}", id.as_bytes()[0]));
    }
    value.truncate(64);
    value
}

fn entry(
    sequence: i64,
    operation_id: &str,
    target: &str,
    asset: &str,
    hash: &str,
) -> ExclusionEntry {
    ExclusionEntry {
        sequence,
        operation_id: operation_id.into(),
        target_id: target.into(),
        asset_id: asset.into(),
        // Passed through verbatim: the validation tests need a malformed value to stay
        // malformed, so normalization here would hide the case they exist to cover.
        asset_sha256: hash.into(),
        created_at: "2026-09-20T00:00:00Z".into(),
    }
}

fn adopt(library: &Library) {
    let id = library_id(library);
    library
        .adopt_character_exclusion_library(ENDPOINT, &id)
        .unwrap();
}

/// Enable cloud sync for `base`, so the endpoint guard admits the scripted server.
///
/// The receive path refuses any endpoint that is not the configured one, so a test driving a
/// real server has to configure it exactly as production would.
fn configure(library: &Library, base: &str) {
    library
        .set_cloud_sync_config(crate::cloud::models::CloudSyncConfig {
            enabled: true,
            api_base_url: Some(base.into()),
        })
        .unwrap();
}

fn latest_decision(library: &Library, target: &str, asset: &str) -> Option<String> {
    let connection = library.connection().unwrap();
    connection
        .query_row(
            "SELECT decision FROM character_decisions WHERE target_id=?1 AND source_asset_id=?2
             ORDER BY sequence DESC LIMIT 1",
            params![target, asset],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
}

fn cursor(library: &Library) -> Option<i64> {
    library
        .character_exclusion_adoption(ENDPOINT)
        .unwrap()
        .map(|(_, cursor)| cursor)
}

#[test]
fn applies_rejection_and_advances_the_cursor_in_one_transaction() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    let items = vec![entry(1, "op-1", "c", "a", &hex_hash("a"))];
    let (applied, consumed, _) = library
        .apply_character_exclusion_page(ENDPOINT, &id, &items)
        .unwrap();
    assert_eq!((applied, consumed), (1, 0));
    assert_eq!(
        latest_decision(&library, "c", "a").as_deref(),
        Some("rejected")
    );
    assert_eq!(cursor(&library), Some(1));
    // The recorded decision carries the same provenance shape the manual path writes.
    let origin: String = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT origin FROM character_decisions WHERE target_id='c' AND source_asset_id='a'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(origin, "manual");
}

#[test]
fn a_moved_out_asset_is_excluded_although_it_left_the_series_folder() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    // `b` sits in another classification, so the ordinary eligibility rule refuses it and
    // the inbound helper has to bypass exactly that rule and nothing else.
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE character_references SET asset_hash='x' WHERE target_id='c'",
            [],
        )
        .unwrap();
    let items = vec![entry(1, "op-1", "c", "b", &hex_hash("b"))];
    let (applied, _, _) = library
        .apply_character_exclusion_page(ENDPOINT, &id, &items)
        .unwrap();
    assert_eq!(applied, 1);
    assert_eq!(
        latest_decision(&library, "c", "b").as_deref(),
        Some("rejected")
    );
    assert_eq!(cursor(&library), Some(1));
}

fn receipts(library: &Library) -> i64 {
    library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM mobile_character_exclusion_receipts",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn a_protected_reference_is_consumed_as_skipped_and_advances_the_cursor() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    let items = vec![entry(1, "op-1", "c", "x", &hex_hash("x"))];
    assert_eq!(
        library
            .apply_character_exclusion_page(ENDPOINT, &id, &items)
            .unwrap(),
        (0, 0, 1)
    );
    assert_eq!(latest_decision(&library, "c", "x"), None);
    assert_eq!(cursor(&library), Some(1));
    assert_eq!(receipts(&library), 1, "a skipped entry is still consumed");
}

#[test]
fn a_changed_asset_hash_is_consumed_as_skipped() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    // The server claims the bytes it saw; this library now holds different ones, so the
    // correction is no longer the decision the user made.
    let items = vec![entry(1, "op-1", "c", "a", "different-bytes")];
    assert_eq!(
        library
            .apply_character_exclusion_page(ENDPOINT, &id, &items)
            .unwrap(),
        (0, 0, 1)
    );
    assert_eq!(latest_decision(&library, "c", "a"), None);
    assert_eq!(cursor(&library), Some(1));
}

#[test]
fn a_missing_target_or_asset_is_consumed_as_skipped() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    // `b` exists but is trashed: the same "never applies again" state as a missing asset.
    library
        .connection()
        .unwrap()
        .execute("UPDATE assets SET status='trash' WHERE id='b'", [])
        .unwrap();
    let items = vec![
        entry(1, "op-1", "missing", "a", &hex_hash("a")),
        entry(2, "op-2", "c", "missing", &hex_hash("a")),
        entry(3, "op-3", "c", "b", &hex_hash("b")),
    ];
    assert_eq!(
        library
            .apply_character_exclusion_page(ENDPOINT, &id, &items)
            .unwrap(),
        (0, 0, 3)
    );
    assert_eq!(latest_decision(&library, "c", "b"), None);
    assert_eq!(cursor(&library), Some(3));
    assert_eq!(receipts(&library), 3);
}

#[test]
fn an_unappliable_entry_does_not_block_later_exclusions() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    // The PC deleted the target before this exclusion arrived.
    let first = vec![entry(1, "op-1", "gone", "a", &hex_hash("a"))];
    assert_eq!(
        library
            .apply_character_exclusion_page(ENDPOINT, &id, &first)
            .unwrap(),
        (0, 0, 1)
    );
    // A replay of the skipped entry is a receipted no-op, not a second skip.
    let replay = vec![
        entry(1, "op-1", "gone", "a", &hex_hash("a")),
        entry(2, "op-2", "c", "a", &hex_hash("a")),
    ];
    assert_eq!(
        library
            .apply_character_exclusion_page(ENDPOINT, &id, &replay)
            .unwrap(),
        (1, 1, 0)
    );
    assert_eq!(
        latest_decision(&library, "c", "a").as_deref(),
        Some("rejected")
    );
    assert_eq!(cursor(&library), Some(2));
}

#[test]
fn a_replayed_operation_is_idempotent_by_receipt() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    let items = vec![entry(1, "op-1", "c", "a", &hex_hash("a"))];
    assert_eq!(
        library
            .apply_character_exclusion_page(ENDPOINT, &id, &items)
            .unwrap(),
        (1, 0, 0)
    );
    // The same operation id arrives again — a lost response, or a retry that raced success.
    assert_eq!(
        library
            .apply_character_exclusion_page(ENDPOINT, &id, &items)
            .unwrap(),
        (0, 1, 0)
    );
    let decisions: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM character_decisions WHERE target_id='c' AND source_asset_id='a'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(decisions, 1, "a replay must not append a second decision");
}

#[test]
fn a_replay_does_not_undo_a_later_explicit_pc_accept() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    let items = vec![entry(1, "op-1", "c", "a", &hex_hash("a"))];
    library
        .apply_character_exclusion_page(ENDPOINT, &id, &items)
        .unwrap();
    assert_eq!(
        latest_decision(&library, "c", "a").as_deref(),
        Some("rejected")
    );

    // The user later accepts the same pair on the PC. That is a newer local decision.
    let fingerprint = {
        let connection = library.connection().unwrap();
        library
            .read_character_target(&connection, "c")
            .unwrap()
            .fingerprint
    };
    library
        .record_character_decisions(crate::library::characters::DecisionRequest {
            target_id: "c".into(),
            expected_fingerprint: fingerprint,
            asset_ids: vec!["a".into()],
            decision: crate::library::characters::DecisionKind::Accepted,
            baseline_fingerprint: None,
            scan_id: None,
        })
        .unwrap();
    assert_eq!(
        latest_decision(&library, "c", "a").as_deref(),
        Some("accepted")
    );

    // The old exclusion is delivered once more. It must not re-reject the re-accepted pair,
    // and it must not resurrect a second decision row.
    assert_eq!(
        library
            .apply_character_exclusion_page(ENDPOINT, &id, &items)
            .unwrap(),
        (0, 1, 0)
    );
    assert_eq!(
        latest_decision(&library, "c", "a").as_deref(),
        Some("accepted")
    );
    let decisions: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM character_decisions WHERE target_id='c' AND source_asset_id='a'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(decisions, 2, "only the rejection and the re-accept exist");
}

#[test]
fn a_page_mixing_valid_and_unappliable_entries_applies_the_valid_ones() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    // The protected reference in the middle is skipped; the entries around it still apply.
    let items = vec![
        entry(1, "op-1", "c", "a", &hex_hash("a")),
        entry(2, "op-2", "c", "x", &hex_hash("x")),
        entry(3, "op-3", "c", "b", &hex_hash("b")),
    ];
    assert_eq!(
        library
            .apply_character_exclusion_page(ENDPOINT, &id, &items)
            .unwrap(),
        (2, 0, 1)
    );
    assert_eq!(
        latest_decision(&library, "c", "a").as_deref(),
        Some("rejected")
    );
    assert_eq!(latest_decision(&library, "c", "x"), None);
    assert_eq!(
        latest_decision(&library, "c", "b").as_deref(),
        Some("rejected")
    );
    assert_eq!(cursor(&library), Some(3));
}

#[test]
fn a_transient_failure_still_rolls_back_the_whole_page() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    // A write that fails at the database layer is not a validation state, so the valid
    // first entry must roll back with it and the cursor must stay put.
    library
        .connection()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER fail_decision BEFORE INSERT ON character_decisions
             WHEN NEW.source_asset_id='b' BEGIN SELECT RAISE(ABORT, 'busy'); END;",
        )
        .unwrap();
    let items = vec![
        entry(1, "op-1", "c", "a", &hex_hash("a")),
        entry(2, "op-2", "c", "b", &hex_hash("b")),
    ];
    assert!(library
        .apply_character_exclusion_page(ENDPOINT, &id, &items)
        .is_err());
    assert_eq!(latest_decision(&library, "c", "a"), None);
    assert_eq!(cursor(&library), Some(0));
    assert_eq!(receipts(&library), 0);
}

#[test]
fn an_empty_page_never_rewinds_the_cursor() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    // A contiguous prefix is applied first, so the cursor is genuinely advanced.
    library
        .apply_character_exclusion_page(
            ENDPOINT,
            &id,
            &[
                entry(1, "op-1", "c", "a", &hex_hash("a")),
                entry(2, "op-2", "c", "b", &hex_hash("b")),
            ],
        )
        .unwrap();
    assert_eq!(cursor(&library), Some(2));
    // A server reporting `hasMore: false` with no entries still yields a page in the receive
    // loop, and the apply must not treat "nothing carried" as "position zero".
    let (applied, consumed, _) = library
        .apply_character_exclusion_page(ENDPOINT, &id, &[])
        .unwrap();
    assert_eq!((applied, consumed), (0, 0));
    assert_eq!(cursor(&library), Some(2), "an empty page must not rewind");
}

#[test]
fn a_replayed_page_does_not_rewind_and_does_not_re_reject() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    let page = [
        entry(1, "op-1", "c", "a", &hex_hash("a")),
        entry(2, "op-2", "c", "b", &hex_hash("b")),
    ];
    assert_eq!(
        library
            .apply_character_exclusion_page(ENDPOINT, &id, &page)
            .unwrap(),
        (2, 0, 0)
    );
    assert_eq!(cursor(&library), Some(2));
    // The same page is delivered again after a lost response. Every entry is at or below the
    // durable cursor, so nothing is applied and the cursor stays exactly where it was.
    assert_eq!(
        library
            .apply_character_exclusion_page(ENDPOINT, &id, &page)
            .unwrap(),
        (0, 2, 0)
    );
    assert_eq!(cursor(&library), Some(2), "a replay must not rewind");
    let decisions: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM character_decisions WHERE source_asset_id IN ('a','b')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(decisions, 2, "no duplicate decision rows from a replay");
}

#[test]
fn a_page_for_another_library_is_refused_and_changes_nothing() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    library
        .apply_character_exclusion_page(
            ENDPOINT,
            &id,
            &[entry(1, "op-1", "c", "a", &hex_hash("a"))],
        )
        .unwrap();
    assert_eq!(cursor(&library), Some(1));
    // The stored identity must equal this library's own. A binding naming another identity
    // means the directory was copied or restored elsewhere, and applying its corrections to
    // this library would be wrong.
    let error = library
        .apply_character_exclusion_page(
            ENDPOINT,
            OTHER_LIBRARY,
            &[entry(2, "op-2", "c", "b", &hex_hash("b"))],
        )
        .unwrap_err();
    assert!(matches!(
        error,
        LibraryError::CharacterExclusionCursorRejected
    ));
    assert_eq!(latest_decision(&library, "c", "b"), None);
    assert_eq!(cursor(&library), Some(1));
}

#[test]
fn a_sequence_gap_is_refused_rather_than_accepted() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    library
        .apply_character_exclusion_page(
            ENDPOINT,
            &id,
            &[entry(1, "op-1", "c", "a", &hex_hash("a"))],
        )
        .unwrap();
    // Entry 3 arrives without entry 2. Accepting it would advance the cursor past a
    // correction that was never seen, and no later read could recover it.
    let error = library
        .apply_character_exclusion_page(
            ENDPOINT,
            &id,
            &[entry(3, "op-3", "c", "b", &hex_hash("b"))],
        )
        .unwrap_err();
    assert!(matches!(error, LibraryError::CharacterExclusionInvalid));
    assert_eq!(latest_decision(&library, "c", "b"), None);
    assert_eq!(
        cursor(&library),
        Some(1),
        "a gap must not advance the cursor"
    );
}

#[test]
fn reusing_an_operation_id_for_different_content_is_refused() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    library
        .apply_character_exclusion_page(
            ENDPOINT,
            &id,
            &[entry(1, "op-1", "c", "a", &hex_hash("a"))],
        )
        .unwrap();
    assert_eq!(cursor(&library), Some(1));
    // Same operation id, different claim. This means the server reused an id for other
    // content, which can never be reconciled locally, so it is refused rather than treated
    // as an already-consumed no-op.
    let error = library
        .apply_character_exclusion_page(
            ENDPOINT,
            &id,
            &[entry(1, "op-1", "c", "b", &hex_hash("b"))],
        )
        .unwrap_err();
    assert!(matches!(error, LibraryError::CharacterExclusionInvalid));
    assert_eq!(latest_decision(&library, "c", "b"), None);
    assert_eq!(cursor(&library), Some(1));
}

#[test]
fn reusing_an_operation_id_for_a_relocated_sequence_is_refused() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    library
        .apply_character_exclusion_page(
            ENDPOINT,
            &id,
            &[
                entry(1, "op-1", "c", "a", &hex_hash("a")),
                entry(2, "op-2", "c", "b", &hex_hash("b")),
            ],
        )
        .unwrap();
    assert_eq!(cursor(&library), Some(2));
    // The recorded receipt for `op-1` sits at sequence 1. Presenting it at another position
    // means the log moved it, which cannot be reconciled locally, so it is refused rather
    // than counted as an already-consumed no-op.
    let error = library
        .apply_character_exclusion_page(
            ENDPOINT,
            &id,
            &[
                entry(2, "op-1", "c", "a", &hex_hash("a")),
                entry(3, "op-3", "c", "b", &hex_hash("b")),
            ],
        )
        .unwrap_err();
    assert!(matches!(error, LibraryError::CharacterExclusionInvalid));
    assert_eq!(cursor(&library), Some(2), "a refused page must not advance");
}

#[test]
fn adoption_is_per_endpoint_and_never_resets_an_existing_cursor() {
    let (_temp, library) = fixture();
    assert_eq!(
        library.character_exclusion_adoption(ENDPOINT).unwrap(),
        None
    );
    adopt(&library);
    let id = library_id(&library);
    assert_eq!(
        library.character_exclusion_adoption(ENDPOINT).unwrap(),
        Some((id.clone(), 0))
    );
    library
        .apply_character_exclusion_page(
            ENDPOINT,
            &id,
            &[entry(1, "op-1", "c", "a", &hex_hash("a"))],
        )
        .unwrap();
    // Re-adopting the same endpoint is a no-op: a concurrent pass must not rewind the
    // cursor another pass already advanced.
    adopt(&library);
    assert_eq!(cursor(&library), Some(1));
}

#[test]
fn page_validation_rejects_every_non_contiguous_shape() {
    let lib = OTHER_LIBRARY;
    let valid = ExclusionPage {
        version: 1,
        library_id: lib.into(),
        after: 0,
        next_cursor: 1,
        has_more: true,
        items: vec![entry(1, "op-1", "c", "a", "a".repeat(64).as_str())],
    };
    assert!(validate_exclusion_page(&valid, lib, 0, 100).is_ok());

    // A page that starts anywhere other than after + 1 would leave a permanent hole.
    let mut gap = valid.clone();
    gap.items = vec![entry(2, "op-1", "c", "a", &"a".repeat(64))];
    gap.next_cursor = 2;
    assert!(validate_exclusion_page(&gap, lib, 0, 100).is_err());

    // A nextCursor that does not describe the entries actually carried.
    let mut mismatch = valid.clone();
    mismatch.next_cursor = 9;
    assert!(validate_exclusion_page(&mismatch, lib, 0, 100).is_err());

    // Another library's page must never be applied or adopted.
    let mut other = valid.clone();
    other.library_id = "11111111111111111111111111111111".into();
    assert!(validate_exclusion_page(&other, lib, 0, 100).is_err());

    // An empty page is a legitimate end-of-log, but not a "has more".
    let empty = ExclusionPage {
        version: 1,
        library_id: lib.into(),
        after: 4,
        next_cursor: 4,
        has_more: false,
        items: vec![],
    };
    assert!(validate_exclusion_page(&empty, lib, 4, 100).is_ok());
    let mut lying = empty.clone();
    lying.has_more = true;
    assert!(validate_exclusion_page(&lying, lib, 4, 100).is_err());

    // A malformed hash can never be applied, so it must not be adopted into the cursor.
    let mut bad_hash = valid.clone();
    bad_hash.items = vec![entry(1, "op-1", "c", "a", "not-a-hash")];
    assert!(validate_exclusion_page(&bad_hash, lib, 0, 100).is_err());
}

// ---------------------------------------------------------------------------
// Bootstrap and receive against a real HTTP server.
//
// The route's *existence* is the feature's only bootstrap signal, so these tests drive a
// scripted server rather than a transport double: a same-process double could not show that a
// 404 is distinguished from an authorization failure or a 5xx, which is exactly the behavior
// that decides whether a PC downgrades to a legacy publication.
// ---------------------------------------------------------------------------

/// A scripted single-response server, returning `(status, body)` for one request.
fn scripted(status: u16, body: &'static str) -> (String, std::thread::JoinHandle<()>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", server.server_addr());
    let handle = std::thread::spawn(move || {
        if let Ok(Some(request)) = server.recv_timeout(std::time::Duration::from_secs(5)) {
            let _ =
                request.respond(tiny_http::Response::from_string(body).with_status_code(status));
        }
    });
    (base, handle)
}

fn page_body(library_id: &str, after: i64, next: i64, has_more: bool, items: &str) -> String {
    format!(
        r#"{{"version":1,"libraryId":"{library_id}","after":{after},"nextCursor":{next},"hasMore":{has_more},"items":[{items}]}}"#
    )
}

/// A capable server answers the probe with an empty page, which is the bootstrap signal.
#[test]
fn probe_reports_capable_when_the_route_answers_with_an_empty_page() {
    let (_temp, library) = fixture();
    let id = library_id(&library);
    let body: &'static str = Box::leak(page_body(&id, 0, 0, false, "").into_boxed_str());
    let (base, handle) = scripted(200, body);
    let client = crate::cloud::client::CloudClient::new(&base).unwrap();
    let page = client
        .character_exclusions("publisher-token", &id, 0, 1)
        .unwrap();
    assert!(
        page.is_some(),
        "an empty page still proves the route exists"
    );
    handle.join().unwrap();
}

/// An older server has no route, and that is the only condition reported as unsupported.
#[test]
fn probe_reports_unsupported_only_for_a_missing_route() {
    let (_temp, library) = fixture();
    let id = library_id(&library);
    let (base, handle) = scripted(404, "");
    let client = crate::cloud::client::CloudClient::new(&base).unwrap();
    assert!(client
        .character_exclusions("publisher-token", &id, 0, 1)
        .unwrap()
        .is_none());
    handle.join().unwrap();
}

/// An authorization failure must never be read as "older server".
#[test]
fn probe_surfaces_authorization_failure_rather_than_downgrading() {
    let (_temp, library) = fixture();
    let id = library_id(&library);
    for status in [401u16, 403] {
        let (base, handle) = scripted(status, "");
        let client = crate::cloud::client::CloudClient::new(&base).unwrap();
        let error = client
            .character_exclusions("publisher-token", &id, 0, 1)
            .unwrap_err();
        assert!(
            matches!(error, LibraryError::CloudUnauthorized),
            "{status}: {error}"
        );
        handle.join().unwrap();
    }
}

/// A `409` is a cursor or library rejection, which is a real failure and not a downgrade.
#[test]
fn probe_surfaces_cursor_rejection_rather_than_downgrading() {
    let (_temp, library) = fixture();
    let id = library_id(&library);
    let (base, handle) = scripted(409, "");
    let client = crate::cloud::client::CloudClient::new(&base).unwrap();
    let error = client
        .character_exclusions("publisher-token", &id, 0, 1)
        .unwrap_err();
    assert!(matches!(
        error,
        LibraryError::CharacterExclusionCursorRejected
    ));
    handle.join().unwrap();
}

/// A server error is transient, so it must stay visible instead of becoming "unsupported".
#[test]
fn probe_surfaces_server_error_rather_than_downgrading() {
    let (_temp, library) = fixture();
    let id = library_id(&library);
    let (base, handle) = scripted(503, "");
    let client = crate::cloud::client::CloudClient::new(&base).unwrap();
    let error = client
        .character_exclusions("publisher-token", &id, 0, 1)
        .unwrap_err();
    assert!(matches!(
        error,
        LibraryError::CharacterExclusionSyncRejected(503)
    ));
    handle.join().unwrap();
}

/// The receive pass drains a real log end to end and reports the persisted cursor.
#[test]
fn receive_applies_a_real_page_and_reports_the_persisted_cursor() {
    let (_temp, library) = fixture();
    let id = library_id(&library);
    let items = format!(
        r#"{{"sequence":1,"operationId":"op-1","targetId":"c","assetId":"a","assetSha256":"{hash}","createdAt":"2026-09-20T00:00:00Z"}}"#,
        hash = hex_hash("a")
    );
    let body: &'static str = Box::leak(page_body(&id, 0, 1, false, &items).into_boxed_str());
    let (base, handle) = scripted(200, body);
    // The scripted server's port is only known now, so the endpoint is bound to it.
    configure(&library, &base);
    library
        .adopt_character_exclusion_library(&base, &id)
        .unwrap();
    let client = crate::cloud::client::CloudClient::new(&base).unwrap();
    let outcome = library
        .receive_character_exclusions_with(&client, "publisher-token", &base)
        .unwrap()
        .unwrap();
    assert_eq!(outcome.applied, 1);
    assert_eq!(outcome.received_cursor, 1);
    handle.join().unwrap();
    assert_eq!(
        latest_decision(&library, "c", "a").as_deref(),
        Some("rejected")
    );
    let stored: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT received_cursor FROM mobile_character_exclusion_sync WHERE endpoint=?1",
            [&base],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, 1);
}

/// An adopted binding against a server that has lost the route fails closed.
#[test]
fn receive_fails_closed_when_an_adopted_server_loses_the_route() {
    let (_temp, library) = fixture();
    let id = library_id(&library);
    let (base, handle) = scripted(404, "");
    configure(&library, &base);
    library
        .adopt_character_exclusion_library(&base, &id)
        .unwrap();
    let client = crate::cloud::client::CloudClient::new(&base).unwrap();
    let error = library
        .receive_character_exclusions_with(&client, "publisher-token", &base)
        .unwrap_err();
    assert!(matches!(error, LibraryError::CharacterExclusionUnsupported));
    handle.join().unwrap();
    let stored: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT received_cursor FROM mobile_character_exclusion_sync WHERE endpoint=?1",
            [&base],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, 0);
}

// ---------------------------------------------------------------------------
// Cursor/receipt consistency and lane bootstrap.
// ---------------------------------------------------------------------------

/// A position below the durable cursor with no receipt is unexplainable, so it fails closed.
///
/// Skipping it silently would hide the divergence and applying it would write behind a
/// position already acknowledged; neither is safe.
#[test]
fn a_below_cursor_entry_without_a_receipt_is_refused() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    library
        .apply_character_exclusion_page(
            ENDPOINT,
            &id,
            &[entry(1, "op-1", "c", "a", &hex_hash("a"))],
        )
        .unwrap();
    assert_eq!(cursor(&library), Some(1));
    // Drop the receipt, leaving the cursor ahead of any evidence that the entry was consumed.
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM mobile_character_exclusion_receipts", [])
        .unwrap();
    let error = library
        .apply_character_exclusion_page(
            ENDPOINT,
            &id,
            &[entry(1, "op-1", "c", "a", &hex_hash("a"))],
        )
        .unwrap_err();
    assert!(matches!(error, LibraryError::CharacterExclusionInvalid));
    assert_eq!(cursor(&library), Some(1), "the cursor must not move");
}

/// Adopting an endpoint dirties the character lane, so the ack publication is scheduled.
///
/// Without this the server could never learn the feature is in use: the first feature-aware
/// snapshot is what creates its state row, and a clean lane would wait for an unrelated edit.
#[test]
fn adopting_dirty_the_character_publication_generation() {
    let (_temp, library) = fixture();
    let id = library_id(&library);
    let generation = |library: &Library| -> i64 {
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT generation FROM mobile_publication_state WHERE kind='characters'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    };
    let before = generation(&library);
    library
        .adopt_character_exclusion_library(ENDPOINT, &id)
        .unwrap();
    assert_eq!(
        generation(&library),
        before + 1,
        "a first adoption must schedule a publication"
    );
    // Re-adopting the same endpoint is a no-op, so it must not manufacture churn.
    let after_first = generation(&library);
    library
        .adopt_character_exclusion_library(ENDPOINT, &id)
        .unwrap();
    assert_eq!(generation(&library), after_first);
}

/// A never-adopted endpoint is bootstrapped by the poll, without waiting for a local edit.
#[test]
fn bootstrap_adopts_a_capable_server_and_records_absence_for_a_legacy_one() {
    let (_temp, library) = fixture();
    let id = library_id(&library);
    assert_eq!(library.character_exclusion_adoption(ENDPOINT).unwrap(), None);

    // An older server has no route, so nothing is adopted and the legacy path stays open.
    let (legacy_base, legacy) = scripted(404, "");
    configure(&library, &legacy_base);
    // The token is injected: the OS credential store must never decide this test.
    let legacy_client = crate::cloud::client::CloudClient::new(&legacy_base).unwrap();
    assert!(!library
        .bootstrap_character_exclusions_with(&legacy_client, "publisher-token", &legacy_base)
        .unwrap());
    assert_eq!(
        library.character_exclusion_adoption(&legacy_base).unwrap(),
        None
    );
    legacy.join().unwrap();

    // A capable server answers an empty page, which is the bootstrap signal.
    let body: &'static str = Box::leak(page_body(&id, 0, 0, false, "").into_boxed_str());
    let (capable_base, capable) = scripted(200, body);
    configure(&library, &capable_base);
    let capable_client = crate::cloud::client::CloudClient::new(&capable_base).unwrap();
    assert!(library
        .bootstrap_character_exclusions_with(&capable_client, "publisher-token", &capable_base)
        .unwrap());
    assert_eq!(
        library.character_exclusion_adoption(&capable_base).unwrap(),
        Some((id, 0)),
        "a capable server is adopted at cursor zero"
    );
    capable.join().unwrap();
}

#[test]
fn cursor_only_advance_schedules_acknowledgement() {
    let (_temp, library) = fixture();
    adopt(&library);
    let id = library_id(&library);
    library.apply_character_exclusion_page(
        ENDPOINT, &id, &[entry(1, "op-1", "c", "a", &hex_hash("a"))],
    ).unwrap();
    library.connection().unwrap().execute(
        "UPDATE mobile_publication_state SET published_generation=generation", [],
    ).unwrap();
    let outcome = library.apply_character_exclusion_page(
        ENDPOINT, &id, &[entry(2, "op-2", "c", "a", &hex_hash("a"))],
    ).unwrap();
    assert_eq!(outcome, (0, 0, 0), "the decision was already rejected");
    assert_eq!(cursor(&library), Some(2));
    let dirty: bool = library.connection().unwrap().query_row(
        "SELECT generation>published_generation FROM mobile_publication_state WHERE kind='characters'",
        [], |row| row.get(0),
    ).unwrap();
    assert!(dirty, "the new receipt still needs publication acknowledgement");
}

#[test]
fn receive_drains_two_pages_using_the_durable_cursor() {
    let (_temp, library) = fixture();
    let id = library_id(&library);
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", server.server_addr());
    let pages: Vec<String> = [(1, "a"), (2, "b")].into_iter().map(|(sequence, asset)| {
        let item = serde_json::to_string(&entry(sequence, &format!("op-{sequence}"), "c", asset, &hex_hash(asset))).unwrap();
        page_body(&id, sequence - 1, sequence, sequence == 1, &item)
    }).collect();
    let handle = std::thread::spawn(move || {
        for (after, body) in pages.into_iter().enumerate() {
            let request = server.recv_timeout(std::time::Duration::from_secs(5)).unwrap().expect("next page requested");
            assert!(request.url().contains(&format!("after={after}")));
            request.respond(tiny_http::Response::from_string(body)).unwrap();
        }
    });
    configure(&library, &base);
    library.adopt_character_exclusion_library(&base, &id).unwrap();
    let client = crate::cloud::client::CloudClient::new(&base).unwrap();
    let outcome = library.receive_character_exclusions_with(&client, "publisher-token", &base).unwrap().unwrap();
    handle.join().unwrap();
    assert_eq!(outcome.received_cursor, 2);
    assert_eq!(outcome.applied, 2);
    for asset in ["a", "b"] {
        assert_eq!(latest_decision(&library, "c", asset).as_deref(), Some("rejected"));
    }
}
