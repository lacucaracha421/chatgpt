//! Manga Catalog duplicate editions on the PC: tiers, whole-catalog comparison, automatic
//! merging and "a person's decision wins", decision mapping, waiting for missing works,
//! the cursor, the upload payload, and one pass through the real client.
use rusqlite::params;
use tempfile::TempDir;

use super::*;
use crate::cloud::catalog_duplicates::DecisionPage;
use crate::library::collection_personal_edits::tests::configure;

const ENDPOINT: &str = "https://sync.example.test";

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS CrawlState(Key TEXT PRIMARY KEY,Value TEXT);
    INSERT OR REPLACE INTO CrawlState VALUES('lakomics.catalog.contentRevision','fixture-v1');
    CREATE TABLE Works(Id INTEGER PRIMARY KEY,Token TEXT,ParentGid INTEGER,ParentKey TEXT,
    FirstGid INTEGER,FirstKey TEXT,CurrentGid INTEGER,CurrentKey TEXT,Thumb TEXT,
    Title TEXT,TitleJpn TEXT,FileCount INTEGER,Category INTEGER,Uploader TEXT,Expunged INTEGER DEFAULT 0);
    CREATE TABLE Tags(WorkId INTEGER,Namespace TEXT,Value TEXT,PRIMARY KEY(WorkId,Namespace,Value)) WITHOUT ROWID;
    INSERT INTO Works(Id,Token,Title,TitleJpn,FileCount,Category) VALUES
    (1,'one','Same title 01','同じ作品のタイトル',20,2),(2,'two','Same title 01','同じ作品のタイトル',20,2),
    (5,'five','(C108) [Circle (Artist)] Summer Witch Story (Series) [Korean]',NULL,32,2),
    (6,'six','(C108) [Circle (Artist)] Summer Witch Story | 여름의 마녀 (Series) [Korean]',NULL,33,2),
    (7,'seven','Unrelated alpha title',NULL,20,2),(8,'eight','Unrelated beta title',NULL,22,2);
    INSERT INTO Tags VALUES(1,'artist','alice'),(2,'artist','alice'),(1,'language','korean'),(2,'language','korean'),
    (5,'artist','bob'),(6,'artist','bob'),(5,'language','korean'),(6,'language','korean'),
    (7,'artist','carol'),(8,'artist','dave'),(7,'language','korean'),(8,'language','korean');";

fn fixture() -> (TempDir, Connection) {
    let dir = TempDir::new().unwrap();
    std::fs::create_dir_all(dir.path().join("backups")).unwrap();
    let c = super::super::db::initialize_database(&dir.path().join("test.sqlite")).unwrap();
    let catalog = dir.path().join("catalog.db");
    Connection::open(&catalog)
        .unwrap()
        .execute_batch(SCHEMA)
        .unwrap();
    c.execute("ATTACH ?1 AS catalog", [catalog.to_str().unwrap()])
        .unwrap();
    c.execute(
        "INSERT INTO catalog_duplicate_sync(endpoint,updated_at) VALUES(?1,'now')",
        [ENDPOINT],
    )
    .unwrap();
    (dir, c)
}

fn rw(id: &str, title: &str, pages: i64, creators: &[&str]) -> ReviewWork {
    ReviewWork {
        work_id: id.into(),
        group_id: format!("g{id}"),
        title: title.into(),
        title_jpn: None,
        pages,
        category: 2,
        creators: creators.iter().map(|c| c.to_string()).collect(),
        languages: vec!["korean".into()],
    }
}

fn entry(sequence: i64, left: &str, right: &str, decision: &str) -> DecisionEntry {
    DecisionEntry {
        sequence,
        operation_id: format!("00000000-0000-4000-8000-{sequence:012}"),
        candidate_id: candidate_id(left, right),
        provider: PROVIDER.into(),
        left_work_id: left.into(),
        right_work_id: right.into(),
        decision: decision.into(),
        hidden_work_id: (decision == "hideEdition").then(|| right.to_string()),
        revision: sequence,
        created_at: "2026-09-25T00:00:00Z".into(),
    }
}

fn cursor(c: &Connection) -> i64 {
    c.query_row(
        "SELECT decision_cursor FROM catalog_duplicate_sync WHERE endpoint=?1",
        [ENDPOINT],
        |r| r.get(0),
    )
    .unwrap()
}

/// Record entries as one page after the current cursor, then apply.
fn receive(c: &Connection, items: &[DecisionEntry]) -> bool {
    let after = cursor(c);
    record_page(c, ENDPOINT, after, items, items.last().unwrap().sequence).unwrap();
    apply_pending(c).unwrap()
}

fn decision(c: &Connection, left: &str, right: &str) -> Option<String> {
    c.query_row(
        "SELECT decision FROM online_catalog_review_decisions WHERE left_anchor=?1 AND right_anchor=?2",
        params![left, right],
        |r| r.get(0),
    )
    .optional()
    .unwrap()
}

fn pair_state(
    c: &Connection,
    left: &str,
    right: &str,
) -> (i64, Option<String>, Option<String>, Option<String>) {
    c.query_row(
        "SELECT human,origin,report,blocked FROM catalog_duplicate_pairs WHERE left_work_id=?1 AND right_work_id=?2",
        params![left, right],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .unwrap()
}

fn keys(found: &[Found]) -> Vec<(String, String)> {
    found
        .iter()
        .map(|f| (f.left.work_id.clone(), f.right.work_id.clone()))
        .collect()
}

fn pair(a: &str, b: &str) -> (String, String) {
    (a.into(), b.into())
}

#[test]
fn catalog_duplicate_tier_is_conservative() {
    let title = "Same exact title";
    let base = rw("1", title, 20, &["artist:alice"]);
    assert_eq!(
        duplicate_tier(&base, &rw("2", title, 20, &["artist:alice"])),
        Tier::Confident
    );
    assert_eq!(
        duplicate_tier(
            &base,
            &rw("2", "same   EXACT title", 20, &["group:x", "artist:alice"])
        ),
        Tier::Confident
    );
    // Any tolerance or missing signal is uncertain.
    assert_eq!(
        duplicate_tier(&base, &rw("2", title, 21, &["artist:alice"])),
        Tier::Uncertain
    );
    assert_eq!(
        duplicate_tier(
            &base,
            &rw("2", "Same exact title | 같은 제목", 20, &["artist:alice"])
        ),
        Tier::Uncertain
    );
    assert_eq!(
        duplicate_tier(&base, &rw("2", title, 20, &["artist:bob"])),
        Tier::Uncertain
    );
    assert_eq!(
        duplicate_tier(&base, &rw("2", title, 20, &[])),
        Tier::Uncertain
    );
    let mut other = rw("2", title, 20, &["artist:alice"]);
    other.category = 3;
    assert_eq!(duplicate_tier(&base, &other), Tier::Uncertain);
    let mut other = rw("2", title, 20, &["artist:alice"]);
    other.languages = vec!["japanese".into()];
    assert_eq!(duplicate_tier(&base, &other), Tier::Uncertain);
    let (mut a, mut b) = (base.clone(), rw("2", title, 20, &["artist:alice"]));
    a.languages.clear();
    b.languages.clear();
    assert_eq!(duplicate_tier(&a, &b), Tier::Uncertain);
    assert_eq!(
        duplicate_tier(
            &rw("1", "Short", 20, &["artist:a"]),
            &rw("2", "Short", 20, &["artist:a"])
        ),
        Tier::Uncertain
    );
}

#[test]
fn catalog_duplicate_scan_covers_the_whole_catalog_not_only_the_window() {
    let (_dir, c) = fixture();
    // 600 newer works push 1, 2, 5, 6 out of the desktop canary's 500-work window.
    for id in 100..700 {
        c.execute(
            "INSERT INTO catalog.Works(Id,Title,FileCount,Category) VALUES(?1,?2,20,2)",
            params![id, format!("Filler work number {id}")],
        )
        .unwrap();
    }
    // A title shared by more than BUCKET works is skipped like the canary does.
    for id in 1000..1010 {
        c.execute("INSERT INTO catalog.Works(Id,Title,FileCount,Category) VALUES(?1,'Same enormous bucket',20,2)", [id]).unwrap();
        c.execute_batch(&format!(
            "INSERT INTO catalog.Tags VALUES({id},'artist','zed'),({id},'language','korean')"
        ))
        .unwrap();
    }
    let found = scan(&c).unwrap();
    assert_eq!(keys(&found), vec![pair("1", "2"), pair("5", "6")]);
    assert_eq!(
        duplicate_tier(&found[0].left, &found[0].right),
        Tier::Confident
    );
    assert_eq!(
        duplicate_tier(&found[1].left, &found[1].right),
        Tier::Uncertain
    );
    // The comparison itself never merges.
    assert!(!same_group(&c, "1", "2").unwrap());
}

#[test]
fn catalog_duplicate_auto_confirm_merges_confident_and_keeps_uncertain_undecided() {
    let (_dir, c) = fixture();
    let found = scan(&c).unwrap();
    assert_eq!(auto_confirm(&c, &found).unwrap(), vec![pair("1", "2")]);
    assert!(same_group(&c, "1", "2").unwrap());
    assert!(!same_group(&c, "5", "6").unwrap());
    assert_eq!(decision(&c, "1", "2").as_deref(), Some("confirm"));
    assert_eq!(decision(&c, "5", "6"), None);
    assert_eq!(
        pair_state(&c, "1", "2"),
        (0, Some("auto".into()), Some("pending".into()), None)
    );
    // Both works are kept: nothing is hidden or removed.
    let members: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM online_catalog_group_members WHERE work_id IN ('1','2')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(members, 2);
    // The merged pair is no candidate any more, but stays in the upload as decided.
    let found = scan(&c).unwrap();
    assert_eq!(keys(&found), vec![pair("5", "6")]);
    assert!(auto_confirm(&c, &found).unwrap().is_empty());
    let items = candidate_items(&c, &found).unwrap();
    let uploaded: Vec<_> = items
        .iter()
        .map(|i| {
            (
                i.left.work_id.as_str(),
                i.right.work_id.as_str(),
                i.reason.as_str(),
                i.page_gap,
            )
        })
        .collect();
    assert_eq!(
        uploaded,
        vec![
            ("1", "2", "exactTitle", 0),
            ("5", "6", "koreanAlternateTitle", 1)
        ]
    );
    // Automatic merges do not use up the human decision ledger.
    assert_eq!(catalog_review::human_decisions(&c).unwrap(), 0);
}

#[test]
fn catalog_duplicate_human_decision_wins_over_automation() {
    let (_dir, c) = fixture();
    let found = scan(&c).unwrap();
    auto_confirm(&c, &found).unwrap();
    // Undo on mobile ("다른 작품"): the merge is split and vetoed, the report dropped.
    assert!(receive(&c, &[entry(1, "1", "2", "notDuplicate")]));
    assert_eq!(decision(&c, "1", "2").as_deref(), Some("falsePositive"));
    assert!(!same_group(&c, "1", "2").unwrap());
    assert_eq!(
        pair_state(&c, "1", "2"),
        (1, Some("server".into()), Some("dropped".into()), None)
    );
    assert!(auto_confirm(&c, &scan(&c).unwrap()).unwrap().is_empty());
    // Cleared on mobile: undecided again, uploaded as a candidate, but never auto-merged.
    assert!(receive(&c, &[entry(2, "1", "2", "cleared")]));
    assert_eq!(decision(&c, "1", "2"), None);
    let found = scan(&c).unwrap();
    assert_eq!(keys(&found), vec![pair("1", "2"), pair("5", "6")]);
    assert!(auto_confirm(&c, &found).unwrap().is_empty());
    assert!(!same_group(&c, "1", "2").unwrap());
    let items = candidate_items(&c, &found).unwrap();
    assert_eq!(items.len(), 2);
    // A desktop decision is human too.
    let (_dir, c) = fixture();
    auto_confirm(&c, &scan(&c).unwrap()).unwrap();
    let row = catalog_review_row(&c, "1", "2");
    let tx = c.unchecked_transaction().unwrap();
    catalog_review_decide(&tx, &row, "split");
    tx.commit().unwrap();
    assert_eq!(
        pair_state(&c, "1", "2"),
        (1, None, Some("dropped".into()), None)
    );
    assert!(!same_group(&c, "1", "2").unwrap());
    assert!(auto_confirm(&c, &scan(&c).unwrap()).unwrap().is_empty());
}

fn catalog_review_row(c: &Connection, left: &str, right: &str) -> catalog_review::ReviewRow {
    catalog_review::list(c)
        .unwrap()
        .into_iter()
        .find(|r| r.left_anchor == left && r.right_anchor == right)
        .unwrap()
}

fn catalog_review_decide(c: &Connection, row: &catalog_review::ReviewRow, decision: &str) {
    catalog_review::decide(
        c,
        &catalog_review::ReviewDecision {
            review_token: row.review_token.clone(),
            left_anchor: row.left_anchor.clone(),
            right_anchor: row.right_anchor.clone(),
            decision: decision.into(),
        },
    )
    .unwrap();
}

#[test]
fn catalog_duplicate_decisions_map_to_local_review_decisions() {
    let (_dir, c) = fixture();
    // keepBoth: same work, both kept → confirm.
    receive(&c, &[entry(1, "5", "6", "keepBoth")]);
    assert_eq!(decision(&c, "5", "6").as_deref(), Some("confirm"));
    assert!(same_group(&c, "5", "6").unwrap());
    // cleared: the row this sync wrote is removed, the pair returns to undecided.
    receive(&c, &[entry(2, "5", "6", "cleared")]);
    assert_eq!(decision(&c, "5", "6"), None);
    assert!(!same_group(&c, "5", "6").unwrap());
    // notDuplicate → falsePositive.
    receive(&c, &[entry(3, "5", "6", "notDuplicate")]);
    assert_eq!(decision(&c, "5", "6").as_deref(), Some("falsePositive"));
    assert!(!same_group(&c, "5", "6").unwrap());
    // hideEdition is not offered: merge, never hide.
    receive(&c, &[entry(4, "1", "2", "hideEdition")]);
    assert_eq!(decision(&c, "1", "2").as_deref(), Some("confirm"));
    assert!(same_group(&c, "1", "2").unwrap());
    let members: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM online_catalog_group_members",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(members, 6);
    // cleared of a pair this sync never wrote leaves a local (desktop) row alone.
    c.execute(
        "INSERT INTO online_catalog_review_decisions VALUES('7','8','falsePositive','{}','now')",
        [],
    )
    .unwrap();
    receive(&c, &[entry(5, "7", "8", "cleared")]);
    assert_eq!(decision(&c, "7", "8").as_deref(), Some("falsePositive"));
    assert_eq!(cursor(&c), 5);
}

#[test]
fn catalog_duplicate_server_found_pair_applies_when_both_works_exist() {
    let (_dir, c) = fixture();
    // 7 and 8 are no local candidate (different titles and creators).
    assert!(!keys(&scan(&c).unwrap()).contains(&pair("7", "8")));
    receive(&c, &[entry(1, "7", "8", "keepBoth")]);
    assert_eq!(decision(&c, "7", "8").as_deref(), Some("confirm"));
    assert!(same_group(&c, "7", "8").unwrap());
    // Kept in the upload so mobile still sees it as decided.
    let items = candidate_items(&c, &scan(&c).unwrap()).unwrap();
    assert!(items
        .iter()
        .any(|i| i.left.work_id == "7" && i.right.work_id == "8"));
}

#[test]
fn catalog_duplicate_pair_with_a_missing_work_waits_without_holding_the_cursor() {
    let (_dir, c) = fixture();
    assert!(receive(
        &c,
        &[
            entry(1, "1", "99", "keepBoth"),
            entry(2, "5", "6", "notDuplicate")
        ]
    ));
    assert_eq!(cursor(&c), 2);
    assert_eq!(decision(&c, "1", "99"), None);
    assert_eq!(decision(&c, "5", "6").as_deref(), Some("falsePositive"));
    assert_eq!(pair_state(&c, "1", "99").3.as_deref(), Some("workMissing"));
    // Still waiting while the catalog lacks the work; applied once it arrives.
    assert!(!apply_pending(&c).unwrap());
    c.execute_batch("INSERT INTO catalog.Works(Id,Token,Title,FileCount,Category) VALUES(99,'n','Late work title',20,2);
        UPDATE catalog.CrawlState SET Value='fixture-v2';").unwrap();
    assert!(apply_pending(&c).unwrap());
    assert_eq!(decision(&c, "1", "99").as_deref(), Some("confirm"));
    assert!(same_group(&c, "1", "99").unwrap());
    assert_eq!(pair_state(&c, "1", "99").3, None);
}

#[test]
fn catalog_duplicate_full_human_ledger_waits_and_automatic_rows_do_not_count() {
    let (_dir, c) = fixture();
    for i in 0..catalog_review::HUMAN_DECISIONS {
        c.execute(
            "INSERT INTO online_catalog_review_decisions VALUES(?1,?2,'falsePositive','{}','now')",
            params![format!("a{i:04}"), format!("b{i:04}")],
        )
        .unwrap();
    }
    receive(&c, &[entry(1, "5", "6", "keepBoth")]);
    assert_eq!(decision(&c, "5", "6"), None);
    assert_eq!(pair_state(&c, "5", "6").3.as_deref(), Some("capacity"));
    // Automatic merges have their own bound.
    assert_eq!(
        auto_confirm(&c, &scan(&c).unwrap()).unwrap(),
        vec![pair("1", "2")]
    );
    c.execute(
        "DELETE FROM online_catalog_review_decisions WHERE left_anchor='a0000'",
        [],
    )
    .unwrap();
    assert!(apply_pending(&c).unwrap());
    assert_eq!(decision(&c, "5", "6").as_deref(), Some("confirm"));
}

#[test]
fn catalog_duplicate_cursor_is_compare_and_set_and_reapply_is_idempotent() {
    let (_dir, c) = fixture();
    let items = [
        entry(1, "5", "6", "keepBoth"),
        entry(2, "1", "2", "notDuplicate"),
    ];
    record_page(&c, ENDPOINT, 0, &items, 2).unwrap();
    assert_eq!(cursor(&c), 2);
    // A replayed (stale) page is refused and changes nothing.
    assert!(matches!(
        record_page(&c, ENDPOINT, 0, &[entry(1, "5", "6", "notDuplicate")], 1),
        Err(LibraryError::CatalogDuplicateCursorRejected)
    ));
    assert_eq!(cursor(&c), 2);
    assert!(apply_pending(&c).unwrap());
    assert_eq!(decision(&c, "5", "6").as_deref(), Some("confirm"));
    // Applying again is a no-op.
    assert!(!apply_pending(&c).unwrap());
    assert_eq!(decision(&c, "5", "6").as_deref(), Some("confirm"));
}

fn item(left: u32, right: u32) -> CandidateItem {
    let work = |id: u32| EvidenceWork {
        work_id: id.to_string(),
        group_id: Some(uuid::Uuid::new_v4().to_string()),
        title: format!("Title of work {id}"),
        title_jpn: None,
        pages: 20,
        category: 2,
        creators: vec!["artist:alice".into()],
        languages: vec!["korean".into()],
    };
    CandidateItem {
        provider: PROVIDER.into(),
        reason: "exactTitle".into(),
        page_gap: 0,
        algorithm: ALGORITHM.into(),
        left: work(left),
        right: work(right),
    }
}

#[test]
fn catalog_duplicate_upload_chunks_share_one_generation_and_end_final() {
    let items: Vec<_> = (0..2500).map(|i| item(100_000 + i, 200_000 + i)).collect();
    let chunks = chunk_publications(items, "pc-1-abc").unwrap();
    assert_eq!(
        chunks.iter().map(|c| c.items.len()).collect::<Vec<_>>(),
        vec![1000, 1000, 500]
    );
    assert_eq!(chunks.iter().filter(|c| c.is_final).count(), 1);
    assert!(chunks.last().unwrap().is_final);
    assert!(chunks
        .iter()
        .all(|c| c.generation == "pc-1-abc" && !c.includes_server_works && c.version == 1));
    let ids: std::collections::HashSet<_> = chunks.iter().map(|c| c.operation_id.clone()).collect();
    assert_eq!(ids.len(), 3);
    assert!(ids
        .iter()
        .all(|id| crate::cloud::catalog_duplicates::valid_operation_id(id)));
    // The exact field names of the server's strict models.
    let json = serde_json::to_value(&chunks[2]).unwrap();
    let mut fields: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
    fields.sort();
    assert_eq!(
        fields,
        [
            "final",
            "generation",
            "includesServerWorks",
            "items",
            "operationId",
            "version"
        ]
    );
    let mut fields: Vec<_> = json["items"][0]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    fields.sort();
    assert_eq!(
        fields,
        [
            "algorithm",
            "left",
            "pageGap",
            "provider",
            "reason",
            "right"
        ]
    );
    let mut fields: Vec<_> = json["items"][0]["left"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    fields.sort();
    assert_eq!(
        fields,
        [
            "category",
            "creators",
            "groupId",
            "languages",
            "pages",
            "title",
            "titleJpn",
            "workId"
        ]
    );
    // An empty set is still one final chunk, which retires older generations.
    let empty = chunk_publications(Vec::new(), "pc-2-abc").unwrap();
    assert_eq!(empty.len(), 1);
    assert!(empty[0].is_final && empty[0].items.is_empty());
    // Items the server would refuse are never built.
    let mut bad = item(1, 2);
    bad.page_gap = 3;
    assert!(!bad.valid());
    let mut bad = item(1, 2);
    bad.left.creators = vec!["x".repeat(521)];
    assert!(!bad.valid());
    assert!(item(1, 2).valid());
}

fn library_fixture() -> (TempDir, Library) {
    let temp = TempDir::new().unwrap();
    let library = Library::open(temp.path()).unwrap();
    std::fs::create_dir_all(temp.path().join("catalogs")).unwrap();
    let catalog = Connection::open(temp.path().join("catalogs/kdata.db")).unwrap();
    catalog.execute_batch(SCHEMA).unwrap();
    (temp, library)
}

fn page(after: i64, items: &[DecisionEntry]) -> String {
    let last = items.last().map_or(after, |i| i.sequence);
    serde_json::to_string(&DecisionPage {
        version: 1,
        after,
        last_sequence: last,
        next_cursor: last,
        has_more: false,
        items: items.to_vec(),
    })
    .unwrap()
}

#[test]
fn catalog_duplicate_pass_through_the_real_client_uploads_and_reports() {
    let (_temp, library) = library_fixture();
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.server_addr());
    let serve = std::thread::spawn(move || {
        let mut seen = Vec::new();
        for _ in 0..3 {
            let mut request = server
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap()
                .expect("request");
            let mut body = String::new();
            std::io::Read::read_to_string(request.as_reader(), &mut body).unwrap();
            let auth = request
                .headers()
                .iter()
                .find(|h| h.field.equiv("Authorization"))
                .map(|h| h.value.to_string());
            let url = request.url().to_string();
            let response = if url.starts_with("/v1/mobile-catalog/duplicates/decisions?after=0") {
                page(0, &[entry(1, "7", "8", "notDuplicate")])
            } else if url == "/v1/mobile-catalog/duplicates/candidates" {
                let sent: serde_json::Value = serde_json::from_str(&body).unwrap();
                serde_json::json!({"version":1,"operationId":sent["operationId"],"generation":sent["generation"],
                    "final":sent["final"],"items":sent["items"].as_array().unwrap().len(),"changed":1,"retired":0,"revision":3}).to_string()
            } else {
                "{}".into()
            };
            seen.push((request.method().to_string(), url, auth, body));
            request
                .respond(tiny_http::Response::from_string(response).with_status_code(200))
                .unwrap();
        }
        seen
    });
    configure(&library, &base);
    let client = CloudClient::new(&base).unwrap();
    library
        .sync_catalog_duplicates_with(&client, "publisher", Some("client"), &base)
        .unwrap();
    let seen = serve.join().unwrap();
    assert_eq!(seen[0].2.as_deref(), Some("Bearer publisher"));
    assert_eq!(
        (seen[1].0.as_str(), seen[1].2.as_deref()),
        ("PUT", Some("Bearer publisher"))
    );
    let upload: serde_json::Value = serde_json::from_str(&seen[1].3).unwrap();
    assert_eq!(upload["final"], true);
    assert_eq!(upload["includesServerWorks"], false);
    let pairs: Vec<(String, String)> = upload["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["left"]["workId"].as_str().unwrap().into(),
                i["right"]["workId"].as_str().unwrap().into(),
            )
        })
        .collect();
    // Confident (auto-merged), uncertain, and the mobile-decided pair.
    assert_eq!(pairs, vec![pair("1", "2"), pair("5", "6"), pair("7", "8")]);
    let (method, url, auth, body) = &seen[2];
    assert_eq!(
        (method.as_str(), url.as_str(), auth.as_deref()),
        (
            "POST",
            "/v1/mobile-catalog/duplicates/decisions",
            Some("Bearer client")
        )
    );
    let command: serde_json::Value = serde_json::from_str(body).unwrap();
    let operation: String = library.connection().unwrap().query_row(
        "SELECT auto_operation_id FROM catalog_duplicate_pairs WHERE left_work_id='1' AND right_work_id='2'", [], |r| r.get(0)).unwrap();
    assert_eq!(
        command,
        serde_json::json!({"version":1,"operationId":operation,"candidateId":candidate_id("1","2"),
        "decision":"keepBoth","hiddenWorkId":null,"expectedRevision":0})
    );
    let c = library.connection().unwrap();
    let state: (String, i64) = c.query_row("SELECT report,(SELECT decision_cursor FROM catalog_duplicate_sync) FROM catalog_duplicate_pairs WHERE left_work_id='1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(state, ("reported".into(), 1));
    let decision: String = c.query_row("SELECT decision FROM online_catalog_review_decisions WHERE left_anchor='7' AND right_anchor='8'", [], |r| r.get(0)).unwrap();
    assert_eq!(decision, "falsePositive");
    drop(c);
    // The echo of this PC's own report is not a human decision; nothing is re-uploaded.
    let echo = DecisionEntry {
        operation_id: operation,
        ..entry(2, "1", "2", "keepBoth")
    };
    record_page(&library.connection().unwrap(), &base, 1, &[echo], 2).unwrap();
    let c = library.connection().unwrap();
    let human: i64 = c
        .query_row(
            "SELECT human FROM catalog_duplicate_pairs WHERE left_work_id='1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(human, 0);
}

#[test]
#[ignore = "read-only real catalog comparison gate; set LAKOMICS_CATALOG_BENCH_ROOT"]
fn catalog_duplicate_real_catalog_scan_gate() {
    let root = std::path::PathBuf::from(std::env::var("LAKOMICS_CATALOG_BENCH_ROOT").unwrap());
    let c = Connection::open_in_memory().unwrap();
    for (schema, path) in [
        ("catalog", "catalogs/kdata.db"),
        ("saved", "library.sqlite"),
    ] {
        let mut uri = url::Url::from_file_path(root.join(path)).unwrap();
        uri.set_query(Some("mode=ro&immutable=1"));
        c.execute(&format!("ATTACH ?1 AS {schema}"), [uri.as_str()])
            .unwrap();
    }
    for sql in [
        include_str!("../../migrations/0035_online_catalog_groups.sql"),
        include_str!("../../migrations/0037_catalog_review.sql"),
        include_str!("../../migrations/0097_catalog_duplicate_sync.sql"),
    ] {
        c.execute_batch(sql).unwrap();
    }
    c.execute_batch("INSERT INTO online_catalog_review_decisions SELECT * FROM saved.online_catalog_review_decisions")
        .unwrap();
    let tx = c.unchecked_transaction().unwrap();
    let start = std::time::Instant::now();
    catalog_groups::ensure_membership(&tx).unwrap();
    eprintln!("materialize_ms={}", start.elapsed().as_millis());
    let start = std::time::Instant::now();
    let found = scan(&tx).unwrap();
    let confident = found
        .iter()
        .filter(|f| duplicate_tier(&f.left, &f.right) == Tier::Confident)
        .count();
    eprintln!(
        "scan_ms={} found={} confident={}",
        start.elapsed().as_millis(),
        found.len(),
        confident
    );
    let start = std::time::Instant::now();
    let merged = auto_confirm(&tx, &found).unwrap();
    eprintln!(
        "auto_ms={} merged={}",
        start.elapsed().as_millis(),
        merged.len()
    );
    let start = std::time::Instant::now();
    let items = candidate_items(&tx, &scan(&tx).unwrap()).unwrap();
    let bytes = serde_json::to_vec(&items).unwrap().len();
    eprintln!(
        "rescan_items_ms={} items={} item_bytes={}",
        start.elapsed().as_millis(),
        items.len(),
        bytes
    );
    let snapshot =
        serde_json::to_vec(&super::super::mobile_catalog::user_snapshot(&tx).unwrap_or_default())
            .unwrap()
            .len();
    eprintln!("user_snapshot_bytes={snapshot}");
    tx.rollback().unwrap();
}

fn add_triangle_work(c: &Connection) {
    c.execute_batch(
        "INSERT INTO catalog.Works(Id,Token,Title,TitleJpn,FileCount,Category) VALUES(3,'three','Same title 01','同じ作品のタイトル',20,2);
         INSERT INTO catalog.Tags VALUES(3,'artist','alice'),(3,'language','korean');",
    )
    .unwrap();
}

#[test]
fn catalog_duplicate_mobile_veto_splits_only_that_pair_of_an_automatic_triangle() {
    let (_dir, c) = fixture();
    add_triangle_work(&c);
    let merged = auto_confirm(&c, &scan(&c).unwrap()).unwrap();
    assert_eq!(merged, vec![pair("1", "2"), pair("1", "3"), pair("2", "3")]);
    assert!(same_group(&c, "1", "2").unwrap() && same_group(&c, "2", "3").unwrap());
    // Pretend every merge was reported already.
    c.execute("UPDATE catalog_duplicate_pairs SET report='reported'", [])
        .unwrap();
    receive(&c, &[entry(1, "1", "2", "notDuplicate")]);
    assert!(!same_group(&c, "1", "2").unwrap());
    // Greedy in work-id order: 1–3 stays merged, 2–3 is withdrawn (it would re-link 1 and 2).
    assert!(same_group(&c, "1", "3").unwrap());
    assert!(!same_group(&c, "2", "3").unwrap());
    assert_eq!(decision(&c, "1", "3").as_deref(), Some("confirm"));
    assert_eq!(decision(&c, "2", "3"), None);
    let (human, origin, _, blocked) = pair_state(&c, "2", "3");
    assert_eq!((human, origin), (0, None));
    let blocked = blocked.unwrap();
    assert!(blocked.starts_with("withdraw:"), "{blocked}");
    // The `cleared` echo of that withdrawal is this PC's own, not a human decision.
    let echo = DecisionEntry {
        operation_id: blocked["withdraw:".len()..].to_string(),
        ..entry(2, "2", "3", "cleared")
    };
    receive(&c, &[echo]);
    assert_eq!(pair_state(&c, "2", "3").0, 0);
    // The withdrawn pair is never merged automatically again.
    assert!(auto_confirm(&c, &scan(&c).unwrap()).unwrap().is_empty());
}

#[test]
fn catalog_duplicate_veto_leaves_a_human_link_alone() {
    let (_dir, c) = fixture();
    add_triangle_work(&c);
    auto_confirm(&c, &scan(&c).unwrap()).unwrap();
    // 1–3 and 2–3 were confirmed by a person on mobile: automation does not own them.
    receive(
        &c,
        &[
            entry(1, "1", "3", "keepBoth"),
            entry(2, "2", "3", "keepBoth"),
        ],
    );
    receive(&c, &[entry(3, "1", "2", "notDuplicate")]);
    // Nothing automatic was withdrawn; the veto quarantines the set as before.
    assert_eq!(decision(&c, "1", "3").as_deref(), Some("confirm"));
    assert_eq!(decision(&c, "2", "3").as_deref(), Some("confirm"));
    assert_eq!(decision(&c, "1", "2").as_deref(), Some("falsePositive"));
    assert!(!same_group(&c, "1", "2").unwrap());
}

#[test]
fn catalog_duplicate_desktop_split_of_a_triangle_splits_only_that_pair() {
    let (_dir, c) = fixture();
    add_triangle_work(&c);
    auto_confirm(&c, &scan(&c).unwrap()).unwrap();
    let row = catalog_review_row(&c, "1", "2");
    catalog_review_decide(&c, &row, "split");
    assert!(!same_group(&c, "1", "2").unwrap());
    assert!(same_group(&c, "1", "3").unwrap());
    assert_eq!(pair_state(&c, "1", "2").0, 1);
}

#[test]
fn catalog_duplicate_review_list_bounds_pending_and_decided_separately() {
    let (_dir, c) = fixture();
    // 1000 automatic decisions and 600 human ones; the pending canary candidate stays listed.
    for i in 0..1000 {
        let (l, r) = (format!("x{i:04}"), format!("y{i:04}"));
        c.execute(
            "INSERT INTO online_catalog_review_decisions VALUES(?1,?2,'confirm','{}','now')",
            params![l, r],
        )
        .unwrap();
        c.execute("INSERT INTO catalog_duplicate_pairs(left_work_id,right_work_id,origin,desired,updated_at) VALUES(?1,?2,'auto','confirm','now')", params![l, r]).unwrap();
    }
    for i in 0..600 {
        c.execute(
            "INSERT INTO online_catalog_review_decisions VALUES(?1,?2,'falsePositive','{}','now')",
            params![format!("0h{i:04}"), format!("0i{i:04}")],
        )
        .unwrap();
    }
    // `{}` evidence is not parseable; give the fake rows real evidence shapes.
    let evidence = serde_json::to_string(&ReviewEvidence {
        left: rw("1", "a", 1, &[]),
        right: rw("2", "a", 1, &[]),
        reason: String::new(),
        algorithm: ALGORITHM.into(),
    })
    .unwrap();
    c.execute(
        "UPDATE online_catalog_review_decisions SET evidence=?1",
        [evidence],
    )
    .unwrap();
    // Work "5"–"6" is a pending candidate of the desktop canary.
    catalog_review_generate(&c);
    let rows = catalog_review::list(&c).unwrap();
    assert!(rows
        .iter()
        .any(|r| r.state == "pending" && r.left_anchor == "5" && r.right_anchor == "6"));
    assert_eq!(rows.iter().filter(|r| r.state != "pending").count(), 550);
    // Human decisions come first in the decided bound.
    assert_eq!(
        rows.iter().filter(|r| r.state == "falsePositive").count(),
        550
    );
    // A pair beyond the bounds is still decidable (looked up directly).
    let row = catalog_review_row(&c, "5", "6");
    c.execute_batch("DELETE FROM online_catalog_review_decisions WHERE left_anchor LIKE '0h%' AND left_anchor>'0h0400'").unwrap();
    catalog_review_decide(&c, &row, "falsePositive");
    assert_eq!(decision(&c, "5", "6").as_deref(), Some("falsePositive"));
}

fn catalog_review_generate(c: &Connection) {
    catalog_review::generate(c).unwrap();
}

#[test]
fn catalog_duplicate_own_echo_does_not_change_the_fingerprint() {
    let (_dir, c) = fixture();
    auto_confirm(&c, &scan(&c).unwrap()).unwrap();
    let before = fingerprint(&c).unwrap();
    let operation: String = c
        .query_row(
            "SELECT auto_operation_id FROM catalog_duplicate_pairs",
            [],
            |r| r.get(0),
        )
        .unwrap();
    c.execute("UPDATE catalog_duplicate_pairs SET report='reported'", [])
        .unwrap();
    let echo = DecisionEntry {
        operation_id: operation,
        ..entry(1, "1", "2", "keepBoth")
    };
    record_page(&c, ENDPOINT, 0, &[echo], 1).unwrap();
    assert_eq!(fingerprint(&c).unwrap(), before);
    // A person's decision does change it.
    record_page(&c, ENDPOINT, 1, &[entry(2, "5", "6", "notDuplicate")], 2).unwrap();
    assert_ne!(fingerprint(&c).unwrap(), before);
}
