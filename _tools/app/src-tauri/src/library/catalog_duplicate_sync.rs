//! Manga Catalog duplicate editions on the PC: whole-catalog comparison, automatic merging
//! of confident pairs, the candidate upload, and applying mobile decisions (server contract:
//! `server/lakomics-api/catalog_duplicates.py`; decided 2026-09-24/25 in the backlog).
//!
//! * **Compare**: every active work of the local catalog, bucketed by the `catalog_review`
//!   title keys (buckets larger than `BUCKET` are skipped, as in the desktop canary), pairs
//!   checked with the shared `catalog_review::pair_match` rule. Pairs with any decision, or
//!   whose edition groups have a negative one, are not candidates; one pair per group pair.
//! * **Merge automatically** ([`duplicate_tier`]): a confident pair gets a local `confirm`
//!   (one edition group, both works kept; nothing is hidden or deleted) and is reported to the
//!   server as `keepBoth`, so mobile lists it as decided and can undo it with "다른 작품". A
//!   pair a person ever decided (mobile or this PC) is never confirmed automatically again.
//!   Uncertain pairs are uploaded undecided for optional mobile review.
//! * **Upload** (`PUT …/candidates`, publisher): the full set, chunked under one generation,
//!   `final: true` on the last chunk. The set also keeps every pair with a server or automatic
//!   decision (merged pairs are no longer candidates locally), so the server does not retire
//!   what mobile shows as decided. `includesServerWorks` is always false: the server keeps
//!   works its own refresh added that this PC's catalog may not have, and retiring
//!   server-found candidates for those would drop still-valid ones.
//! * **Decisions** (`GET …/decisions`, publisher, `after` exclusive): each entry is recorded
//!   in `catalog_duplicate_pairs` together with the cursor step (one transaction per page),
//!   then applied to `online_catalog_review_decisions`: `keepBoth` and `hideEdition` →
//!   `confirm` (hiding is not offered, user 2026-09-25; nothing is hidden), `notDuplicate` →
//!   `falsePositive`, `cleared` → remove the row this sync wrote (the pair returns to
//!   undecided; a `split` would be a stronger veto than the person asked for). An entry
//!   whose works are not in the local catalog yet waits and applies once the catalog catches
//!   up; the cursor never waits for it.
//!
//! Runs in its own publication lane at most once a minute; the comparison and upload run
//! only when the catalog or a decision changed (fingerprint), at most every ten minutes.
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use super::{
    catalog_groups,
    catalog_review::{self, ReviewEvidence, ReviewWork, ALGORITHM, BUCKET},
    error::LibraryError,
    Library,
};
use crate::cloud::catalog_duplicates::{
    candidate_id, CandidateItem, CommandOutcome, DecisionCommand, DecisionEntry, EvidenceWork,
    Publication, CHUNK_ITEMS, MAX_CHUNK_BYTES, PAGE_LIMIT, PROVIDER,
};
use crate::cloud::client::CloudClient;
use crate::library::credential;

/// Log pages one pass may record; the durable cursor drains a backlog across passes.
const MAX_PAGES: usize = 10;
/// Automatic merges this PC keeps at most. Each is a decision row that the catalog
/// publication carries in its user snapshot (8 MiB bound, ~0.8 KB per row).
pub(super) const AUTO_DECISIONS: i64 = 5_000;
/// Automatic merge reports sent per pass.
const REPORTS_PER_PASS: usize = 500;
/// Part of the fingerprint: a rule or tier change compares and uploads again.
const RULES: &str = "catalog-duplicates-v1";

/// How sure the PC is that a candidate pair is the same work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Tier {
    /// Merged automatically (and reported as `keepBoth`).
    Confident,
    /// Uploaded undecided for optional mobile review.
    Uncertain,
}

/// Confident only when every signal agrees with no tolerance: the full title (or the
/// Japanese title) is identical after whitespace/case normalization (8+ characters), the
/// page counts are equal, the category (1..=11) and the non-empty language list are equal,
/// and at least one `artist:`/`group:` tag is shared. Everything else the candidate rule
/// accepts is uncertain: a match only after dropping an appended Korean title, any page
/// difference, missing creators or languages, or a category mismatch.
pub(crate) fn duplicate_tier(a: &ReviewWork, b: &ReviewWork) -> Tier {
    let confident = catalog_review::exact_title_match(a, b)
        && a.pages > 0
        && a.pages == b.pages
        && (1..=11).contains(&a.category)
        && a.category == b.category
        && !a.languages.is_empty()
        && a.languages == b.languages
        && a.creators.iter().any(|c| b.creators.contains(c));
    if confident {
        Tier::Confident
    } else {
        Tier::Uncertain
    }
}

/// One undecided candidate of the whole-catalog comparison; `left.work_id < right.work_id`.
#[derive(Debug, Clone)]
pub(super) struct Found {
    pub left: ReviewWork,
    pub right: ReviewWork,
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn title_keys(title: &str, title_jpn: Option<&str>) -> BTreeSet<String> {
    [
        catalog_review::review_title(title),
        catalog_review::review_title(title_jpn.unwrap_or("")),
    ]
    .into_iter()
    .filter(|key| key.chars().count() >= 8)
    .collect()
}

fn key_hash(key: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    key.hash(&mut hasher);
    hasher.finish()
}

/// A work with its membership, or `None` when it is not in the local catalog.
fn load(c: &Connection, id: &str) -> Result<Option<ReviewWork>, LibraryError> {
    match catalog_review::work(c, id) {
        Ok(work) => Ok(Some(work)),
        Err(LibraryError::Database(rusqlite::Error::QueryReturnedNoRows)) => Ok(None),
        Err(error) => Err(error),
    }
}

fn anchor(c: &Connection, group: &str) -> Result<Option<String>, LibraryError> {
    Ok(c
        .query_row(
            "SELECT anchor_work_id FROM online_catalog_group_handles WHERE provider='kHentai' AND group_id=?1",
            [group],
            |r| r.get(0),
        )
        .optional()?)
}

/// Compare the whole local catalog. Caller owns a transaction with `catalog` attached.
///
/// Pass one streams `(Id, Title, TitleJpn)` of the active works and sorts hashed title keys
/// (16 bytes per key); pass two reads full evidence only for works in a bucket of 2..=BUCKET,
/// re-checking the real key (a hash collision can only make a bucket look larger).
pub(super) fn scan(c: &Connection) -> Result<Vec<Found>, LibraryError> {
    catalog_groups::ensure_membership(c)?;
    let mut keyed: Vec<(u64, i64)> = Vec::new();
    {
        let mut s = c.prepare("SELECT Id,Title,TitleJpn FROM catalog.Works WHERE Expunged=0")?;
        let mut rows = s.query([])?;
        while let Some(row) = rows.next()? {
            let id: i64 = row.get(0)?;
            let title: Option<String> = row.get(1)?;
            let jpn: Option<String> = row.get(2)?;
            for key in title_keys(title.as_deref().unwrap_or(""), jpn.as_deref()) {
                keyed.push((key_hash(&key), id));
            }
        }
    }
    keyed.sort_unstable();
    keyed.dedup();
    let mut cache: HashMap<i64, Option<ReviewWork>> = HashMap::new();
    let mut pairs: BTreeMap<(String, String), Found> = BTreeMap::new();
    let mut start = 0;
    while start < keyed.len() {
        let hash = keyed[start].0;
        let end = start
            + keyed[start..]
                .iter()
                .take_while(|(h, _)| *h == hash)
                .count();
        let ids: Vec<i64> = keyed[start..end].iter().map(|(_, id)| *id).collect();
        start = end;
        if ids.len() < 2 || ids.len() > BUCKET {
            continue;
        }
        let mut buckets: BTreeMap<String, Vec<i64>> = BTreeMap::new();
        for id in &ids {
            if !cache.contains_key(id) {
                cache.insert(*id, load(c, &id.to_string())?);
            }
            if let Some(work) = &cache[id] {
                for key in title_keys(&work.title, work.title_jpn.as_deref()) {
                    if key_hash(&key) == hash {
                        buckets.entry(key).or_default().push(*id);
                    }
                }
            }
        }
        for bucket in buckets.values() {
            for (pos, i) in bucket.iter().enumerate() {
                for j in &bucket[pos + 1..] {
                    let (Some(a), Some(b)) = (&cache[i], &cache[j]) else {
                        continue;
                    };
                    if catalog_review::pair_match(a, b).is_none() {
                        continue;
                    }
                    let (left, right) = if a.work_id < b.work_id {
                        (a, b)
                    } else {
                        (b, a)
                    };
                    pairs
                        .entry((left.work_id.clone(), right.work_id.clone()))
                        .or_insert_with(|| Found {
                            left: left.clone(),
                            right: right.clone(),
                        });
                }
            }
        }
    }
    // Undecided only, and one pair per edition-group pair (the first by work id).
    let mut groups = HashSet::new();
    let mut found = Vec::new();
    for ((left, right), pair) in pairs {
        let (gl, gr) = (&pair.left.group_id, &pair.right.group_id);
        let group_pair = if gl < gr {
            (gl.clone(), gr.clone())
        } else {
            (gr.clone(), gl.clone())
        };
        if groups.contains(&group_pair) || catalog_review::reviewed(c, &left, &right, gl, gr)? {
            continue;
        }
        if let (Some(mut a), Some(mut b)) = (anchor(c, gl)?, anchor(c, gr)?) {
            if a > b {
                std::mem::swap(&mut a, &mut b);
            }
            if catalog_review::reviewed(c, &a, &b, gl, gr)? {
                continue;
            }
        }
        groups.insert(group_pair);
        found.push(pair);
    }
    Ok(found)
}

fn evidence(left: &ReviewWork, right: &ReviewWork) -> Result<String, LibraryError> {
    let exact = catalog_review::exact_title_match(left, right);
    serde_json::to_string(&ReviewEvidence {
        left: left.clone(),
        right: right.clone(),
        reason: catalog_review::reason_text(exact, left.pages.abs_diff(right.pages)),
        algorithm: ALGORITHM.into(),
    })
    .map_err(|_| LibraryError::InvalidOnlineCatalog)
}

fn write_decision(
    c: &Connection,
    left: &ReviewWork,
    right: &ReviewWork,
    decision: &str,
) -> Result<(), LibraryError> {
    c.execute(
        "INSERT INTO online_catalog_review_decisions VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(left_anchor,right_anchor) DO UPDATE SET decision=excluded.decision,
         evidence=excluded.evidence,reviewed_at=excluded.reviewed_at",
        params![
            left.work_id,
            right.work_id,
            decision,
            evidence(left, right)?,
            now()
        ],
    )?;
    Ok(())
}

fn same_group(c: &Connection, left: &str, right: &str) -> Result<bool, LibraryError> {
    Ok(c.query_row(
        "SELECT a.group_id=b.group_id FROM online_catalog_group_members a
             JOIN online_catalog_group_members b ON b.provider=a.provider
             WHERE a.provider='kHentai' AND a.work_id=?1 AND b.work_id=?2",
        params![left, right],
        |r| r.get(0),
    )
    .optional()?
    .unwrap_or(false))
}

fn group_of(c: &Connection, work: &str) -> Result<Option<String>, LibraryError> {
    Ok(c.query_row(
        "SELECT group_id FROM online_catalog_group_members WHERE provider='kHentai' AND work_id=?1",
        [work],
        |r| r.get(0),
    )
    .optional()?)
}

/// A person decided that `left` and `right` are different works (a `falsePositive` or a
/// `split`), while they currently share one edition group. `apply_decisions` would then
/// quarantine the whole merged set, undoing every merge in it. Instead, withdraw only the
/// automatic merges (never a human one) that keep the two works linked: all of them are
/// taken out, then each is put back unless it would link the two works again (greedy, in
/// work-id order), so exactly the vetoed pair separates. If a human confirm or lineage still
/// links the two works, everything is left as it was and the conflict is logged (the veto
/// then quarantines the set, as before). A withdrawn merge that was already reported is
/// queued for a `cleared` report (`blocked = 'withdraw:<operation id>'`). Call it before
/// writing the negative decision; the caller rebuilds afterwards.
pub(super) fn withdraw_auto_links(
    c: &Connection,
    left: &str,
    right: &str,
    revision: &str,
) -> Result<(), LibraryError> {
    let (Some(g), Some(h)) = (group_of(c, left)?, group_of(c, right)?) else {
        return Ok(());
    };
    if g != h {
        return Ok(());
    }
    type Row = (String, String, String, String, String);
    let links: Vec<Row> = c
        .prepare(
            "SELECT d.left_anchor,d.right_anchor,d.decision,d.evidence,d.reviewed_at
             FROM online_catalog_review_decisions d
             JOIN online_catalog_group_members a ON a.provider='kHentai' AND a.work_id=d.left_anchor
             JOIN online_catalog_group_members b ON b.provider='kHentai' AND b.work_id=d.right_anchor
             WHERE d.decision='confirm' AND a.group_id=?1 AND b.group_id=?1
               AND ((d.left_anchor=?2 AND d.right_anchor=?3) OR EXISTS(SELECT 1 FROM catalog_duplicate_pairs p
                 WHERE p.left_work_id=d.left_anchor AND p.right_work_id=d.right_anchor
                   AND p.origin='auto' AND p.human=0))
             ORDER BY 1,2",
        )?
        .query_map(params![g, left, right], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<Result<_, _>>()?;
    let others: Vec<&Row> = links
        .iter()
        .filter(|l| !(l.0 == left && l.1 == right))
        .collect();
    if others.is_empty() {
        return Ok(());
    }
    let restore = |row: &Row| -> Result<(), LibraryError> {
        c.execute(
            "INSERT OR REPLACE INTO online_catalog_review_decisions VALUES(?1,?2,?3,?4,?5)",
            params![row.0, row.1, row.2, row.3, row.4],
        )?;
        Ok(())
    };
    for row in &links {
        c.execute(
            "DELETE FROM online_catalog_review_decisions WHERE left_anchor=?1 AND right_anchor=?2",
            params![row.0, row.1],
        )?;
    }
    catalog_groups::rebuild(c, revision)?;
    if same_group(c, left, right)? {
        eprintln!(
            "catalog duplicates: {left}/{right} were decided different works, but a human merge or lineage links them; left as is"
        );
        for row in &links {
            restore(row)?;
        }
        catalog_groups::rebuild(c, revision)?;
        return Ok(());
    }
    // Union-find over the edition groups without any automatic link.
    let mut parent: HashMap<String, String> = HashMap::new();
    fn find(parent: &mut HashMap<String, String>, x: &str) -> String {
        let next = parent.get(x).cloned().unwrap_or_else(|| x.to_owned());
        if next == x {
            return next;
        }
        let root = find(parent, &next);
        parent.insert(x.to_owned(), root.clone());
        root
    }
    let (ga, gb) = (
        group_of(c, left)?.unwrap_or_default(),
        group_of(c, right)?.unwrap_or_default(),
    );
    for row in others {
        let (Some(gx), Some(gy)) = (group_of(c, &row.0)?, group_of(c, &row.1)?) else {
            continue;
        };
        let (rx, ry) = (find(&mut parent, &gx), find(&mut parent, &gy));
        let (ra, rb) = (find(&mut parent, &ga), find(&mut parent, &gb));
        if (rx == ra || ry == ra) && (rx == rb || ry == rb) {
            // Putting this merge back would link the vetoed works again: withdraw it.
            let operation = uuid::Uuid::new_v4().to_string();
            c.execute(
                "UPDATE catalog_duplicate_pairs SET origin=NULL,desired=NULL,applied=1,
                 blocked=CASE WHEN report='reported' THEN 'withdraw:'||?3 ELSE 'withdrawn' END,
                 report=CASE WHEN report='pending' THEN 'dropped' ELSE report END,updated_at=?4
                 WHERE left_work_id=?1 AND right_work_id=?2",
                params![row.0, row.1, operation, now()],
            )?;
            eprintln!("catalog duplicates: automatic merge {}/{} withdrawn after a person split {left}/{right}", row.0, row.1);
            continue;
        }
        parent.insert(rx, ry);
        restore(row)?;
    }
    Ok(())
}

fn membership_revision(c: &Connection) -> Result<String, LibraryError> {
    catalog_groups::ensure_membership(c)
}

/// Confirm every confident, never-seen pair locally (bounded by [`AUTO_DECISIONS`]) and queue
/// its `keepBoth` report. A pair with any row in `catalog_duplicate_pairs` was decided by a
/// person or already handled by automation, so it is never confirmed again. A confirmation
/// that an existing veto keeps from merging is withdrawn. Returns the merged pairs.
pub(super) fn auto_confirm(
    c: &Connection,
    found: &[Found],
) -> Result<Vec<(String, String)>, LibraryError> {
    let mut count: i64 = c.query_row(
        "SELECT COUNT(*) FROM catalog_duplicate_pairs WHERE origin='auto'",
        [],
        |r| r.get(0),
    )?;
    let mut made = Vec::new();
    for pair in found {
        if duplicate_tier(&pair.left, &pair.right) != Tier::Confident {
            continue;
        }
        if count >= AUTO_DECISIONS {
            break;
        }
        let (left, right) = (&pair.left.work_id, &pair.right.work_id);
        let seen: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM catalog_duplicate_pairs WHERE left_work_id=?1 AND right_work_id=?2)",
            params![left, right],
            |r| r.get(0),
        )?;
        // The comparison ran on an earlier read snapshot: recheck against the current state.
        let (Some(gl), Some(gr)) = (group_of(c, left)?, group_of(c, right)?) else {
            continue;
        };
        if seen || gl == gr || catalog_review::reviewed(c, left, right, &gl, &gr)? {
            continue;
        }
        write_decision(c, &pair.left, &pair.right, "confirm")?;
        c.execute(
            "INSERT INTO catalog_duplicate_pairs(left_work_id,right_work_id,origin,desired,applied,report,
                auto_operation_id,updated_at) VALUES(?1,?2,'auto','confirm',1,'pending',?3,?4)",
            params![left, right, uuid::Uuid::new_v4().to_string(), now()],
        )?;
        count += 1;
        made.push((left.clone(), right.clone()));
    }
    if made.is_empty() {
        return Ok(made);
    }
    let revision = membership_revision(c)?;
    catalog_groups::rebuild(c, &revision)?;
    let mut blocked = Vec::new();
    for (left, right) in &made {
        if !same_group(c, left, right)? {
            blocked.push((left.clone(), right.clone()));
        }
    }
    if !blocked.is_empty() {
        for (left, right) in &blocked {
            c.execute(
                "DELETE FROM online_catalog_review_decisions WHERE left_anchor=?1 AND right_anchor=?2",
                params![left, right],
            )?;
            c.execute(
                "UPDATE catalog_duplicate_pairs SET origin=NULL,desired=NULL,report='dropped',blocked='conflict',
                 updated_at=?3 WHERE left_work_id=?1 AND right_work_id=?2",
                params![left, right, now()],
            )?;
        }
        catalog_groups::rebuild(c, &revision)?;
        made.retain(|pair| !blocked.contains(pair));
    }
    Ok(made)
}

/// Apply every recorded decision that is not in place yet. Caller owns a transaction with
/// `catalog` attached. Returns whether local decisions (and so edition groups) changed.
pub(super) fn apply_pending(c: &Connection) -> Result<bool, LibraryError> {
    type Pending = (String, String, Option<String>, Option<String>);
    let rows: Vec<Pending> = c
        .prepare(
            "SELECT left_work_id,right_work_id,origin,desired FROM catalog_duplicate_pairs
             WHERE applied=0 ORDER BY server_sequence,left_work_id,right_work_id",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<Result<_, _>>()?;
    if rows.is_empty() {
        return Ok(false);
    }
    let revision = membership_revision(c)?;
    let mut changed = false;
    for (left, right, origin, desired) in rows {
        let Some(desired) = desired else {
            // `cleared`: remove only the row this sync wrote.
            if origin.is_some() {
                changed |= c.execute(
                    "DELETE FROM online_catalog_review_decisions WHERE left_anchor=?1 AND right_anchor=?2",
                    params![left, right],
                )? > 0;
            }
            c.execute(
                "UPDATE catalog_duplicate_pairs SET origin=NULL,applied=1,blocked=NULL,updated_at=?3
                 WHERE left_work_id=?1 AND right_work_id=?2",
                params![left, right, now()],
            )?;
            continue;
        };
        let block = |reason: &str| -> Result<(), LibraryError> {
            c.execute(
                "UPDATE catalog_duplicate_pairs SET blocked=?3 WHERE left_work_id=?1 AND right_work_id=?2",
                params![left, right, reason],
            )?;
            Ok(())
        };
        let (Some(a), Some(b)) = (load(c, &left)?, load(c, &right)?) else {
            block("workMissing")?;
            continue;
        };
        let exists: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM online_catalog_review_decisions WHERE left_anchor=?1 AND right_anchor=?2)",
            params![left, right],
            |r| r.get(0),
        )?;
        // Mobile decisions share the human ledger bound; they wait (never lost) when it is full.
        if !exists
            && origin.as_deref() == Some("server")
            && catalog_review::human_decisions(c)? >= catalog_review::HUMAN_DECISIONS
        {
            eprintln!(
                "catalog duplicates: the decision ledger is full ({} human decisions); {left}/{right} waits",
                catalog_review::HUMAN_DECISIONS
            );
            block("capacity")?;
            continue;
        }
        if desired != "confirm" {
            withdraw_auto_links(c, &left, &right, &revision)?;
        }
        write_decision(c, &a, &b, &desired)?;
        c.execute(
            "UPDATE catalog_duplicate_pairs SET applied=1,blocked=NULL,updated_at=?3
             WHERE left_work_id=?1 AND right_work_id=?2",
            params![left, right, now()],
        )?;
        changed = true;
    }
    if changed {
        catalog_groups::rebuild(c, &revision)?;
    }
    Ok(changed)
}

/// Record one validated log page and advance the cursor from `after` to its end, atomically
/// and compare-and-set, so a replayed page is harmless and a stale one cannot rewind.
pub(super) fn record_page(
    c: &Connection,
    endpoint: &str,
    after: i64,
    items: &[DecisionEntry],
    next_cursor: i64,
) -> Result<(), LibraryError> {
    let tx = c.unchecked_transaction()?;
    for item in items {
        record_entry(&tx, item)?;
    }
    let advanced = tx.execute(
        "UPDATE catalog_duplicate_sync SET decision_cursor=?2,updated_at=?4
         WHERE endpoint=?1 AND decision_cursor=?3",
        params![endpoint, next_cursor, after, now()],
    )?;
    if advanced != 1 {
        return Err(LibraryError::CatalogDuplicateCursorRejected);
    }
    tx.commit()?;
    Ok(())
}

fn record_entry(c: &Connection, item: &DecisionEntry) -> Result<(), LibraryError> {
    let (left, right) = (&item.left_work_id, &item.right_work_id);
    let own: Option<bool> = c
        .query_row(
            "SELECT auto_operation_id=?3 OR blocked IN ('withdraw:'||?3,'withdrawn:'||?3)
             FROM catalog_duplicate_pairs WHERE left_work_id=?1 AND right_work_id=?2",
            params![left, right, item.operation_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let server_decision = (item.decision != "cleared").then_some(item.decision.as_str());
    if own == Some(true) {
        // This PC's own automatic `keepBoth` (or the `cleared` withdrawing it), echoed by
        // the log: not a human decision.
        c.execute(
            "UPDATE catalog_duplicate_pairs SET report='reported',server_decision=?3,server_sequence=?4,
             updated_at=?5 WHERE left_work_id=?1 AND right_work_id=?2",
            params![left, right, server_decision, item.sequence, now()],
        )?;
        return Ok(());
    }
    let desired = match item.decision.as_str() {
        "keepBoth" => Some("confirm"),
        "hideEdition" => {
            eprintln!(
                "catalog duplicates: hideEdition for {left}/{right} is applied as a merge; no work is hidden"
            );
            Some("confirm")
        }
        "notDuplicate" => Some("falsePositive"),
        _ => None,
    };
    let time = now();
    match desired {
        Some(desired) => c.execute(
            "INSERT INTO catalog_duplicate_pairs(left_work_id,right_work_id,server_decision,server_sequence,human,
                origin,desired,applied,updated_at) VALUES(?1,?2,?3,?4,1,'server',?5,0,?6)
             ON CONFLICT(left_work_id,right_work_id) DO UPDATE SET server_decision=excluded.server_decision,
                server_sequence=excluded.server_sequence,human=1,origin='server',desired=excluded.desired,
                applied=0,blocked=NULL,report=CASE WHEN report='pending' THEN 'dropped' ELSE report END,
                updated_at=excluded.updated_at",
            params![left, right, server_decision, item.sequence, desired, time],
        )?,
        None => c.execute(
            "INSERT INTO catalog_duplicate_pairs(left_work_id,right_work_id,server_decision,server_sequence,human,
                applied,updated_at) VALUES(?1,?2,NULL,?3,1,1,?4)
             ON CONFLICT(left_work_id,right_work_id) DO UPDATE SET server_decision=NULL,
                server_sequence=excluded.server_sequence,human=1,desired=NULL,
                applied=CASE WHEN origin IS NULL THEN 1 ELSE 0 END,blocked=NULL,
                report=CASE WHEN report='pending' THEN 'dropped' ELSE report END,updated_at=excluded.updated_at",
            params![left, right, item.sequence, time],
        )?,
    };
    Ok(())
}

fn evidence_work(work: &ReviewWork) -> EvidenceWork {
    EvidenceWork {
        work_id: work.work_id.clone(),
        group_id: Some(work.group_id.clone())
            .filter(|g| crate::cloud::catalog_duplicates::valid_token(g)),
        title: work.title.clone(),
        title_jpn: work.title_jpn.clone(),
        pages: work
            .pages
            .clamp(0, crate::cloud::catalog_duplicates::MAX_COUNT),
        category: work
            .category
            .clamp(0, crate::cloud::catalog_duplicates::MAX_COUNT),
        creators: work.creators.clone(),
        languages: work.languages.clone(),
    }
}

/// The upload set: every undecided candidate plus every pair with a server or automatic
/// decision whose works are still in the local catalog (merged pairs are no longer
/// candidates, and mobile still shows them as decided). Evidence is read fresh; an item the
/// server would refuse (page gap over 2, out-of-bounds values) is left out.
pub(super) fn candidate_items(
    c: &Connection,
    found: &[Found],
) -> Result<Vec<CandidateItem>, LibraryError> {
    let mut keys: BTreeSet<(String, String)> = found
        .iter()
        .map(|pair| (pair.left.work_id.clone(), pair.right.work_id.clone()))
        .collect();
    let tracked: Vec<(String, String)> = c
        .prepare(
            "SELECT left_work_id,right_work_id FROM catalog_duplicate_pairs
             WHERE server_decision IS NOT NULL OR (origin IS NOT NULL AND desired IS NOT NULL)",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    keys.extend(tracked);
    let mut items = Vec::new();
    for (left, right) in keys {
        let (Some(a), Some(b)) = (load(c, &left)?, load(c, &right)?) else {
            continue;
        };
        let exact = catalog_review::exact_title_match(&a, &b);
        let gap = a.pages.abs_diff(b.pages);
        let item = CandidateItem {
            provider: PROVIDER.into(),
            reason: if exact {
                "exactTitle"
            } else {
                "koreanAlternateTitle"
            }
            .into(),
            page_gap: gap.min(3) as i64,
            algorithm: ALGORITHM.into(),
            left: evidence_work(&a),
            right: evidence_work(&b),
        };
        if item.valid() {
            items.push(item);
        }
    }
    Ok(items)
}

/// Split the set into chunks of one generation; the last (or only, possibly empty) chunk is
/// `final`, which retires this PC's candidates of older generations on the server.
pub(super) fn chunk_publications(
    items: Vec<CandidateItem>,
    generation: &str,
) -> Result<Vec<Publication>, LibraryError> {
    let mut chunks: Vec<Vec<CandidateItem>> = vec![Vec::new()];
    let mut bytes = 0;
    for item in items {
        let size = serde_json::to_vec(&item)
            .map_err(|_| LibraryError::InvalidCloudResponse)?
            .len()
            + 1;
        let current = chunks.last().map_or(0, Vec::len);
        if current > 0 && (current >= CHUNK_ITEMS || bytes + size > MAX_CHUNK_BYTES) {
            chunks.push(Vec::new());
            bytes = 0;
        }
        bytes += size;
        chunks.last_mut().expect("one chunk").push(item);
    }
    let last = chunks.len() - 1;
    Ok(chunks
        .into_iter()
        .enumerate()
        .map(|(index, items)| Publication {
            version: 1,
            operation_id: uuid::Uuid::new_v4().to_string(),
            generation: generation.into(),
            is_final: index == last,
            includes_server_works: false,
            items,
        })
        .collect())
}

/// Fingerprint of everything the upload set depends on (catalog content, decisions, and the
/// pair state), excluding report bookkeeping and the server's echo of this PC's own reports,
/// so reporting never forces a new comparison. Caller has `catalog` attached; read it in the
/// same snapshot as the data it describes.
fn fingerprint(c: &Connection) -> Result<String, LibraryError> {
    let content: String = c.query_row(
        "SELECT COALESCE((SELECT Value FROM catalog.CrawlState WHERE Key='lakomics.catalog.contentRevision'),'legacy')",
        [],
        |r| r.get(0),
    )?;
    let digest = |sql: &str| -> Result<String, LibraryError> {
        let mut hash = Sha256::new();
        let mut s = c.prepare(sql)?;
        let mut rows = s.query([])?;
        while let Some(row) = rows.next()? {
            for index in 0..row.as_ref().column_count() {
                let value: Option<String> = row
                    .get::<_, Option<rusqlite::types::Value>>(index)?
                    .map(|v| format!("{v:?}"));
                hash.update(value.unwrap_or_default());
                hash.update([0x1f]);
            }
            hash.update([0x1e]);
        }
        Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
    };
    let decisions = digest(
        "SELECT left_anchor,right_anchor,decision FROM online_catalog_review_decisions ORDER BY 1,2",
    )?;
    let pairs = digest(
        "SELECT left_work_id,right_work_id,human,origin,desired,applied
         FROM catalog_duplicate_pairs ORDER BY 1,2",
    )?;
    Ok(hex(serde_json::json!([
        RULES, ALGORITHM, content, decisions, pairs
    ])
    .to_string()))
}

impl Library {
    fn ensure_catalog_duplicate_sync(&self, endpoint: &str) -> Result<(), LibraryError> {
        self.connection()?.execute(
            "INSERT OR IGNORE INTO catalog_duplicate_sync(endpoint,updated_at) VALUES(?1,?2)",
            params![endpoint, now()],
        )?;
        Ok(())
    }

    /// Claim this pass: true at most once a minute per endpoint, durably.
    fn claim_catalog_duplicate_pass(&self, endpoint: &str) -> Result<bool, LibraryError> {
        Ok(self.connection()?.execute(
            "UPDATE catalog_duplicate_sync SET last_polled=unixepoch()
             WHERE endpoint=?1 AND last_polled<=unixepoch()-60",
            [endpoint],
        )? == 1)
    }

    fn catalog_duplicate_cursor(&self, endpoint: &str) -> Result<i64, LibraryError> {
        Ok(self.connection()?.query_row(
            "SELECT decision_cursor FROM catalog_duplicate_sync WHERE endpoint=?1",
            [endpoint],
            |r| r.get(0),
        )?)
    }

    /// The `catalogDuplicates` publication lane.
    pub(crate) fn run_due_catalog_duplicates(&self, endpoint: &str) -> Result<(), LibraryError> {
        if crate::workload::is_restricted() || !self.root.join("catalogs/kdata.db").is_file() {
            return Ok(());
        }
        let config = self.cloud_sync_config()?;
        if !config.enabled || config.api_base_url.as_deref() != Some(endpoint) {
            return Ok(());
        }
        let publisher = match credential::read_cloud_publisher_token_os() {
            Ok(token) => token,
            Err(LibraryError::CloudCredentialNotConfigured) => return Ok(()),
            Err(error) => return Err(error),
        };
        // Reports go through the client route; the server's `require_client` also accepts the
        // publisher role, so the publisher token serves when no client token is stored.
        let api = credential::read_cloud_api_token_os().ok();
        let client = CloudClient::new(endpoint)?;
        let reporter = api
            .as_ref()
            .map(|token| token.expose())
            .unwrap_or(publisher.expose());
        self.sync_catalog_duplicates_with(&client, publisher.expose(), Some(reporter), endpoint)
    }

    /// One pass with an injected transport and credentials: receive decisions, apply what can
    /// be applied, compare/merge/upload when due, then report automatic merges. Network work
    /// holds no database lock. A receive failure does not stop the local steps; the first
    /// error is returned.
    pub(crate) fn sync_catalog_duplicates_with(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        api_token: Option<&str>,
        endpoint: &str,
    ) -> Result<(), LibraryError> {
        self.ensure_catalog_duplicate_sync(endpoint)?;
        if !self.claim_catalog_duplicate_pass(endpoint)? {
            return Ok(());
        }
        let received =
            match self.receive_catalog_duplicate_decisions(client, publisher_token, endpoint) {
                Ok(()) | Err(LibraryError::CatalogDuplicateUnsupported) => Ok(()),
                Err(error) => Err(error),
            };
        let mut changed = self.apply_catalog_duplicate_decisions()?;
        let uploaded = self.upload_due_catalog_duplicates(client, publisher_token, endpoint);
        match &uploaded {
            Ok(merged) => changed |= *merged,
            Err(error) => eprintln!("catalog duplicate upload: {error}"),
        }
        if changed {
            self.request_catalog_preparation();
        }
        if let Some(api_token) = api_token {
            if let Err(error) = self.report_automatic_merges(client, api_token, endpoint) {
                eprintln!("catalog duplicate reports: {error}");
            }
        }
        received.and(uploaded.map(|_| ()))
    }

    /// Record up to [`MAX_PAGES`] log pages. A server whose log restarted (cursor ahead of
    /// its last sequence) is read again from the start.
    pub(crate) fn receive_catalog_duplicate_decisions(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        endpoint: &str,
    ) -> Result<(), LibraryError> {
        for _ in 0..MAX_PAGES {
            let cursor = self.catalog_duplicate_cursor(endpoint)?;
            let page = match client.catalog_duplicate_decisions(publisher_token, cursor, PAGE_LIMIT)
            {
                Err(LibraryError::CatalogDuplicateCursorRejected) if cursor > 0 => {
                    eprintln!(
                        "catalog duplicates: the server decision log restarted; reading it again"
                    );
                    self.connection()?.execute(
                        "UPDATE catalog_duplicate_sync SET decision_cursor=0 WHERE endpoint=?1",
                        [endpoint],
                    )?;
                    continue;
                }
                result => result?.ok_or(LibraryError::CatalogDuplicateUnsupported)?,
            };
            if !page.items.is_empty() {
                record_page(
                    &*self.connection()?,
                    endpoint,
                    cursor,
                    &page.items,
                    page.next_cursor,
                )?;
            }
            if !page.has_more || page.items.is_empty() {
                break;
            }
        }
        Ok(())
    }

    /// Apply recorded decisions that are not in place yet (see [`apply_pending`]).
    pub(crate) fn apply_catalog_duplicate_decisions(&self) -> Result<bool, LibraryError> {
        let pending: bool = self.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM catalog_duplicate_pairs WHERE applied=0)",
            [],
            |r| r.get(0),
        )?;
        if !pending {
            return Ok(false);
        }
        let _guard = self
            .catalog_file_lock
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut c = self.connection()?;
        super::catalog_preparation::attach_catalog_readonly(&c, &self.root)?;
        let tx = c.transaction()?;
        let changed = apply_pending(&tx)?;
        tx.commit()?;
        Ok(changed)
    }

    fn catalog_duplicate_fingerprint(&self) -> Result<String, LibraryError> {
        let mut reader = self.catalog_read_connection()?;
        let tx = reader.transaction()?;
        fingerprint(&tx)
    }

    /// A short write transaction with `catalog` attached (holds the library lock).
    fn with_catalog_write<T>(
        &self,
        work: impl FnOnce(&Connection) -> Result<T, LibraryError>,
    ) -> Result<T, LibraryError> {
        let _guard = self
            .catalog_file_lock
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut c = self.connection()?;
        super::catalog_preparation::attach_catalog_readonly(&c, &self.root)?;
        let tx = c.transaction()?;
        let result = work(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    /// Compare, merge confident pairs and upload the set when the fingerprint changed and no
    /// retry delay is running. Returns whether automatic merges changed edition groups.
    ///
    /// The comparison and the upload set are built on read-only snapshots, without the
    /// library lock; only the membership refresh and the automatic merges (rechecked against
    /// the current state) are short writes. The uploaded fingerprint is read in the same
    /// snapshot as the uploaded set.
    pub(crate) fn upload_due_catalog_duplicates(
        &self,
        client: &CloudClient,
        publisher_token: &str,
        endpoint: &str,
    ) -> Result<bool, LibraryError> {
        let (uploaded, retry): (Option<String>, bool) = self.connection()?.query_row(
            "SELECT uploaded_input,retry_after<=unixepoch() FROM catalog_duplicate_sync WHERE endpoint=?1",
            [endpoint],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if !retry || uploaded.as_deref() == Some(self.catalog_duplicate_fingerprint()?.as_str()) {
            return Ok(false);
        }
        self.connection()?.execute(
            "UPDATE catalog_duplicate_sync SET retry_after=unixepoch()+300 WHERE endpoint=?1",
            [endpoint],
        )?;
        let revision = self.with_catalog_write(membership_revision)?;
        let found = {
            let mut reader = self.catalog_read_connection()?;
            let tx = reader.transaction()?;
            scan(&tx)?
        };
        let merged = self.with_catalog_write(|c| {
            if membership_revision(c)? != revision {
                return Ok(Vec::new()); // the catalog changed meanwhile: merge on the next pass
            }
            auto_confirm(c, &found)
        })?;
        let merged = !merged.is_empty();
        let (items, input) = {
            let mut reader = self.catalog_read_connection()?;
            let tx = reader.transaction()?;
            (candidate_items(&tx, &found)?, fingerprint(&tx)?)
        };
        let generation = format!(
            "pc-{}-{}",
            chrono::Utc::now().timestamp_millis(),
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
        for publication in chunk_publications(items, &generation)? {
            let body =
                serde_json::to_vec(&publication).map_err(|_| LibraryError::InvalidCloudResponse)?;
            match client.publish_catalog_duplicates(publisher_token, &body)? {
                Some(result)
                    if result.operation_id == publication.operation_id
                        && result.generation == generation
                        && result.is_final == publication.is_final => {}
                Some(_) => return Err(LibraryError::InvalidCloudResponse),
                None => {
                    self.connection()?.execute(
                        "UPDATE catalog_duplicate_sync SET retry_after=unixepoch()+3600 WHERE endpoint=?1",
                        [endpoint],
                    )?;
                    return Ok(merged);
                }
            }
        }
        self.connection()?.execute(
            "UPDATE catalog_duplicate_sync SET uploaded_input=?2,retry_after=unixepoch()+600,updated_at=?3
             WHERE endpoint=?1",
            params![endpoint, input, now()],
        )?;
        Ok(merged)
    }

    /// Report pending automatic merges as `keepBoth` (client token, like a mobile device),
    /// only while the server holds this PC's current set (so each candidate exists there).
    /// A person who decided first wins: the report is dropped and the log brings their
    /// decision. The operation id is stored, so a retry after a lost response is idempotent.
    pub(crate) fn report_automatic_merges(
        &self,
        client: &CloudClient,
        api_token: &str,
        endpoint: &str,
    ) -> Result<usize, LibraryError> {
        let uploaded: Option<String> = self.connection()?.query_row(
            "SELECT uploaded_input FROM catalog_duplicate_sync WHERE endpoint=?1",
            [endpoint],
            |r| r.get(0),
        )?;
        if uploaded.as_deref() != Some(self.catalog_duplicate_fingerprint()?.as_str()) {
            return Ok(0);
        }
        let pending: Vec<(String, String, String)> = self
            .connection()?
            .prepare(
                "SELECT left_work_id,right_work_id,auto_operation_id FROM catalog_duplicate_pairs
                 WHERE report='pending' AND origin='auto' AND human=0 AND auto_operation_id IS NOT NULL
                 ORDER BY left_work_id,right_work_id LIMIT ?1",
            )?
            .query_map([REPORTS_PER_PASS as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        let mut reported = 0;
        for (left, right, operation_id) in pending {
            let command = DecisionCommand {
                version: 1,
                operation_id,
                candidate_id: candidate_id(&left, &right),
                decision: "keepBoth".into(),
                hidden_work_id: None,
                expected_revision: 0,
            };
            let state = match client.decide_catalog_duplicate(api_token, &command)? {
                CommandOutcome::Recorded => "reported",
                // The server holds this PC's current set, so a missing candidate was left out
                // of it (its evidence did not fit the server's bounds): nothing to report.
                CommandOutcome::Refused | CommandOutcome::CandidateMissing => "dropped",
                CommandOutcome::Unsupported => break,
            };
            self.connection()?.execute(
                "UPDATE catalog_duplicate_pairs SET report=?3 WHERE left_work_id=?1 AND right_work_id=?2
                 AND report='pending'",
                params![left, right, state],
            )?;
            reported += usize::from(state == "reported");
        }
        // Withdrawn automatic merges that were reported: take the `keepBoth` back.
        let withdrawn: Vec<(String, String, String)> = self
            .connection()?
            .prepare(
                "SELECT left_work_id,right_work_id,substr(blocked,10) FROM catalog_duplicate_pairs
                 WHERE blocked LIKE 'withdraw:%' AND human=0 ORDER BY left_work_id,right_work_id LIMIT ?1",
            )?
            .query_map([REPORTS_PER_PASS as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        for (left, right, operation_id) in withdrawn {
            let command = DecisionCommand {
                version: 1,
                operation_id: operation_id.clone(),
                candidate_id: candidate_id(&left, &right),
                decision: "cleared".into(),
                hidden_work_id: None,
                expected_revision: 1,
            };
            if client.decide_catalog_duplicate(api_token, &command)? == CommandOutcome::Unsupported
            {
                break;
            }
            // Recorded, or refused because someone decided first (the log brings that).
            self.connection()?.execute(
                "UPDATE catalog_duplicate_pairs SET blocked='withdrawn:'||?3
                 WHERE left_work_id=?1 AND right_work_id=?2 AND blocked='withdraw:'||?3",
                params![left, right, operation_id],
            )?;
        }
        Ok(reported)
    }
}

#[cfg(test)]
#[path = "catalog_duplicate_sync_tests.rs"]
mod tests;
