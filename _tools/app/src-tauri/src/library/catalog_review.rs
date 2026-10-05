//! Whole-catalog duplicate-edition review. Discovery never participates in search.
use super::{catalog_groups, error::LibraryError, Library};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::collections::BTreeSet;
use std::collections::{BTreeMap, HashMap, HashSet};

pub(super) const ALGORITHM: &str = "translated-title-multisignal-canary-v2";
#[cfg(test)]
const WINDOW: usize = 500;
pub(super) const BUCKET: usize = 8;
#[cfg(test)]
const CANDIDATES: usize = 50;
const TAGS: usize = 64;
/// The bounded canary ledger of human decisions. Automatic merges
/// (`catalog_duplicate_sync`) have their own bound and do not use this one up.
pub(super) const HUMAN_DECISIONS: i64 = 500;
#[cfg(test)]
thread_local! { static QUEUE_SCANS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

/// Decision rows not owned by an automatic merge.
pub(super) fn human_decisions(c: &Connection) -> Result<i64, LibraryError> {
    Ok(c.query_row(
        "SELECT COUNT(*) FROM online_catalog_review_decisions d WHERE NOT EXISTS(
            SELECT 1 FROM catalog_duplicate_pairs p WHERE p.left_work_id=d.left_anchor
            AND p.right_work_id=d.right_anchor AND p.origin='auto')",
        [],
        |r| r.get(0),
    )?)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewWork {
    pub work_id: String,
    pub group_id: String,
    pub title: String,
    pub title_jpn: Option<String>,
    pub pages: i64,
    pub category: i64,
    pub creators: Vec<String>,
    pub languages: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEvidence {
    pub left: ReviewWork,
    pub right: ReviewWork,
    pub reason: String,
    pub algorithm: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRow {
    pub review_token: String,
    pub left_anchor: String,
    pub right_anchor: String,
    pub state: String,
    pub evidence: ReviewEvidence,
    pub actionable: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPage {
    pub rows: Vec<ReviewRow>,
    pub inspected_works: usize,
    pub comparisons: usize,
    pub skipped_buckets: usize,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDecision {
    pub review_token: String,
    pub left_anchor: String,
    pub right_anchor: String,
    pub decision: String,
}

/// Shared by Library clones: opening Home and its dialog compares an unchanged catalog
/// once. No schema change or catalog write is needed to discover pending candidates.
#[derive(Debug, Default, Serialize, Deserialize)]
pub(super) struct QueueCache {
    input: Option<String>,
    found: Vec<super::catalog_duplicate_sync::Found>,
    count: Option<usize>,
}

impl QueueCache {
    pub(super) fn candidates(
        &mut self,
        c: &Connection,
    ) -> Result<&[super::catalog_duplicate_sync::Found], LibraryError> {
        let input = queue_input(c)?;
        if self.input.as_deref() != Some(input.as_str()) {
            #[cfg(test)]
            QUEUE_SCANS.with(|scans| scans.set(scans.get() + 1));
            self.found = super::catalog_duplicate_sync::scan(c)?;
            self.input = Some(input);
            self.count = None;
        }
        Ok(&self.found)
    }

    fn load(&mut self, path: &std::path::Path) {
        if self.input.is_none() {
            if let Some(saved) = std::fs::read(path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Self>(&bytes).ok())
            {
                *self = saved;
            }
        }
    }

    fn persist(&self, path: &std::path::Path) {
        // Disposable derived data: a failed/interrupted write only causes another scan.
        // UUID staging avoids partial readers and collisions between app processes.
        let Some(parent) = path.parent() else { return };
        let Ok(bytes) = serde_json::to_vec(self) else {
            return;
        };
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
        let temporary = parent.join(format!("review-{}.tmp", uuid::Uuid::new_v4()));
        if std::fs::write(&temporary, bytes).is_ok() {
            // Windows rename cannot replace an existing file. The cache is optional.
            let _ = std::fs::remove_file(path);
            let _ = std::fs::rename(&temporary, path);
        }
        let _ = std::fs::remove_file(temporary);
    }
}

fn queue_input(c: &Connection) -> Result<String, LibraryError> {
    Ok(format!(
        "{}:{}",
        candidate_context(c)?,
        super::catalog_duplicate_sync::fingerprint(c)?
    ))
}

fn pending_row(
    c: &Connection,
    pair: &super::catalog_duplicate_sync::Found,
) -> Result<ReviewRow, LibraryError> {
    let (exact, gap) =
        pair_match(&pair.left, &pair.right).ok_or(LibraryError::InvalidOnlineCatalog)?;
    let mut row = make_row(
        c,
        pair.left.work_id.clone(),
        pair.right.work_id.clone(),
        "pending".into(),
        ReviewEvidence {
            left: pair.left.clone(),
            right: pair.right.clone(),
            reason: reason_text(exact, gap),
            algorithm: ALGORITHM.into(),
        },
        Some(candidate_context(c)?),
    )?;
    // Home counts actionable rows. Do not advertise a save that the existing
    // bounded decision ledger would reject even with unchanged evidence.
    row.actionable &= human_decisions(c)? < HUMAN_DECISIONS;
    Ok(row)
}

fn whole_catalog_page(c: &Connection, cache: &mut QueueCache) -> Result<ReviewPage, LibraryError> {
    cache.candidates(c)?;
    // Retain decision history and its split action, but never mix in the canary queue.
    let mut queue = Vec::new();
    for pair in &cache.found {
        queue.push(pending_row(c, pair)?);
    }
    cache.count = Some(queue.iter().filter(|row| row.actionable).count());
    queue.extend(rows(c, None, false)?);
    Ok(ReviewPage {
        rows: queue,
        inspected_works: 0,
        comparisons: 0,
        skipped_buckets: 0,
    })
}

fn queue_decision_row(
    c: &Connection,
    cache: &QueueCache,
    query: &ReviewDecision,
) -> Result<ReviewRow, LibraryError> {
    if let Some(row) = rows(c, Some((&query.left_anchor, &query.right_anchor)), false)?
        .into_iter()
        .next()
    {
        return Ok(row);
    }
    // Never recompare the catalog while holding the library writer lock.
    // Any concurrent change requires reloading the queue before deciding.
    if cache.input.as_deref() != Some(queue_input(c)?.as_str()) {
        return Err(LibraryError::InvalidOnlineCatalog);
    }
    let pair = cache
        .found
        .iter()
        .find(|pair| {
            pair.left.work_id == query.left_anchor && pair.right.work_id == query.right_anchor
        })
        .ok_or(LibraryError::OnlineCatalogWorkNotFound)?;
    pending_row(c, pair)
}

fn root(parent: &mut [usize], i: usize) -> usize {
    if parent[i] != i {
        parent[i] = root(parent, parent[i]);
    }
    parent[i]
}

/// Strong components are indivisible. A negative decision quarantines its entire
/// positive heuristic component, so even an alternate confirmation path cannot
/// silently override a split. Dormant anchors remain stored for a later return.
pub(super) fn apply_decisions(
    c: &Connection,
    base: Vec<Vec<String>>,
) -> Result<Vec<Vec<String>>, LibraryError> {
    let mut owners = HashMap::new();
    for (i, group) in base.iter().enumerate() {
        for id in group {
            owners.insert(id.as_str(), i);
        }
    }
    let mut parent: Vec<_> = (0..base.len()).collect();
    let mut s = c.prepare("SELECT left_anchor,right_anchor,decision FROM online_catalog_review_decisions ORDER BY left_anchor,right_anchor")?;
    let decisions = s
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (a, b, d) in &decisions {
        if d != "confirm" {
            continue;
        }
        if let (Some(&a), Some(&b)) = (owners.get(a.as_str()), owners.get(b.as_str())) {
            let x = root(&mut parent, a);
            let y = root(&mut parent, b);
            parent[y] = x;
        }
    }
    let mut blocked = HashSet::new();
    for (a, b, d) in &decisions {
        if d == "confirm" {
            continue;
        }
        if let (Some(&a), Some(&b)) = (owners.get(a.as_str()), owners.get(b.as_str())) {
            // A heuristic rejection never tears apart trusted lineage itself.
            let x = root(&mut parent, a);
            let y = root(&mut parent, b);
            if a != b && x == y {
                blocked.insert(x);
            }
        }
    }
    let mut merged: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    for (i, group) in base.into_iter().enumerate() {
        let r = root(&mut parent, i);
        let key = if blocked.contains(&r) { i } else { r };
        merged.entry(key).or_default().extend(group);
    }
    Ok(merged.into_values().collect())
}

fn normalize(s: &str) -> String {
    // Keep punctuation/numbers/edition qualifiers: do not erase identity evidence.
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

// Only remove a clearly delimited Korean alternate title. Keep all bracketed
// event, creator, franchise and edition qualifiers as identity evidence.
pub(super) fn review_title(s: &str) -> String {
    let normalized = normalize(s);
    let Some((original, alternate)) = normalized.split_once(" | ") else {
        return normalized;
    };
    let suffix = alternate.find(['(', '[']).unwrap_or(alternate.len());
    let translation = alternate[..suffix].trim();
    if original.chars().count() < 8
        || translation.contains('|')
        || !translation.chars().any(|c| ('\u{ac00}'..='\u{d7a3}').contains(&c))
    {
        return normalized;
    }
    normalize(&format!("{original} {}", &alternate[suffix..]))
}

pub(super) fn exact_title_match(a: &ReviewWork, b: &ReviewWork) -> bool {
    [&a.title, a.title_jpn.as_deref().unwrap_or("")]
        .iter()
        .any(|left| {
            let left = normalize(left);
            left.chars().count() >= 8
                && [&b.title, b.title_jpn.as_deref().unwrap_or("")]
                    .iter()
                    .any(|right| left == normalize(right))
        })
}
pub(super) fn work(c: &Connection, id: &str) -> Result<ReviewWork, LibraryError> {
    let mut w = c.query_row("SELECT w.Id,m.group_id,w.Title,w.TitleJpn,w.FileCount,COALESCE(w.Category,0)
        FROM catalog.Works w JOIN online_catalog_group_members m ON m.provider='kHentai' AND m.catalog_work_id=w.Id WHERE w.Id=?1",
        [id], |r| Ok(ReviewWork { work_id:r.get::<_,i64>(0)?.to_string(),group_id:r.get(1)?, title:r.get(2)?,title_jpn:r.get(3)?,pages:r.get(4)?,category:r.get(5)?,creators:vec![],languages:vec![] }))?;
    let mut s=c.prepare("SELECT Namespace,Value FROM catalog.Tags WHERE WorkId=?1 AND Namespace IN ('artist','group','language') ORDER BY Namespace,Value LIMIT ?2")?;
    let tags = s
        .query_map(params![id, (TAGS + 1) as i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if tags.len() > TAGS {
        return Ok(w);
    } // Incomplete evidence is ineligible.
    for (n, v) in tags {
        if v.trim().is_empty() {
            continue;
        }
        if n == "language" {
            w.languages.push(v);
        } else {
            w.creators.push(format!("{n}:{v}"));
        }
    }
    Ok(w)
}
#[cfg(test)]
fn anchor(c: &Connection, group: &str) -> Result<String, LibraryError> {
    Ok(c.query_row("SELECT anchor_work_id FROM online_catalog_group_handles WHERE provider='kHentai' AND group_id=?1",[group],|r|r.get(0))?)
}
/// The candidate rule shared by the windowed desktop canary (`generate`) and the whole-
/// catalog comparison of `catalog_duplicate_sync`: `(exact title, page gap)` when two works
/// of different edition groups are a duplicate-edition candidate.
pub(super) fn pair_match(a: &ReviewWork, b: &ReviewWork) -> Option<(bool, u64)> {
    let exact_title = exact_title_match(a, b);
    let page_gap = a.pages.abs_diff(b.pages);
    let pages_match = a.pages == b.pages
        || (!exact_title && page_gap <= 2 && page_gap <= a.pages.min(b.pages).max(0) as u64 / 10);
    if a.group_id == b.group_id
        || a.pages <= 0
        || b.pages <= 0
        || !pages_match
        || !(1..=11).contains(&a.category)
        || a.category != b.category
        || a.languages.is_empty()
        || a.languages != b.languages
        || !a.creators.iter().any(|v| b.creators.contains(v))
    {
        return None;
    }
    Some((exact_title, page_gap))
}

pub(super) fn reason_text(exact_title: bool, page_gap: u64) -> String {
    if exact_title {
        "제목 일치 · 작가/그룹 중복 · 페이지 수, 분류, 언어 일치".into()
    } else {
        format!("덧붙인 한국어 제목 제외 시 제목 일치 · 작가/그룹 중복 · 분류, 언어 일치 · 페이지 수 차이 {page_gap}쪽")
    }
}

/// Whether this exact pair has any decision, or its two edition groups have a negative one.
pub(super) fn reviewed(
    c: &Connection,
    left: &str,
    right: &str,
    left_group: &str,
    right_group: &str,
) -> Result<bool, LibraryError> {
    Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM online_catalog_review_decisions d
        LEFT JOIN online_catalog_group_members a ON a.provider='kHentai' AND a.work_id=d.left_anchor
        LEFT JOIN online_catalog_group_members b ON b.provider='kHentai' AND b.work_id=d.right_anchor
        WHERE (d.left_anchor=?1 AND d.right_anchor=?2) OR (d.decision!='confirm' AND
        ((a.group_id=?3 AND b.group_id=?4) OR (a.group_id=?4 AND b.group_id=?3))))",
        params![left, right, left_group, right_group], |r| r.get(0))?)
}

// Historical canary fixtures retain coverage of the original discovery/token contract.
#[cfg(test)]
pub(super) fn generate(c: &Connection) -> Result<ReviewPage, LibraryError> {
    catalog_groups::ensure_membership(c)?;
    let revision = candidate_context(c)?;
    let mut s = c.prepare("SELECT Id FROM catalog.Works ORDER BY Id DESC LIMIT ?1")?;
    let ids = s
        .query_map([WINDOW as i64], |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut works = Vec::new();
    for id in &ids {
        let active: bool = c.query_row(
            "SELECT Expunged=0 FROM catalog.Works WHERE Id=?1",
            [id],
            |r| r.get(0),
        )?;
        if active {
            works.push(work(c, &id.to_string())?);
        }
    }
    let mut buckets: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, w) in works.iter().enumerate() {
        let keys = [
            review_title(&w.title),
            review_title(w.title_jpn.as_deref().unwrap_or("")),
        ]
        .into_iter()
        .collect::<BTreeSet<_>>();
        for key in keys {
            if key.chars().count() >= 8 {
                buckets.entry(key).or_default().push(i);
            }
        }
    }
    c.execute("DELETE FROM online_catalog_review_candidates", [])?;
    let mut comparisons = 0;
    let mut skipped = 0;
    let mut pairs = BTreeSet::new();
    for bucket in buckets.values() {
        if bucket.len() > BUCKET {
            skipped += 1;
            continue;
        }
        for (pos, &i) in bucket.iter().enumerate() {
            for &j in &bucket[pos + 1..] {
                comparisons += 1;
                let a = &works[i];
                let b = &works[j];
                let Some((exact_title, page_gap)) = pair_match(a, b) else {
                    continue;
                };
                let mut left = anchor(c, &a.group_id)?;
                let mut right = anchor(c, &b.group_id)?;
                let mut evidence = ReviewEvidence {
                    left: a.clone(),
                    right: b.clone(),
                    reason: reason_text(exact_title, page_gap),
                    algorithm: ALGORITHM.into(),
                };
                if left > right {
                    std::mem::swap(&mut left, &mut right);
                    std::mem::swap(&mut evidence.left, &mut evidence.right);
                }
                let reviewed = reviewed(c, &left, &right, &a.group_id, &b.group_id)?;
                if reviewed
                    || pairs.len() >= CANDIDATES
                    || !pairs.insert((left.clone(), right.clone()))
                {
                    continue;
                }
                c.execute(
                    "INSERT INTO online_catalog_review_candidates VALUES(?1,?2,?3,?4,?5)",
                    params![
                        left,
                        right,
                        ALGORITHM,
                        revision,
                        serde_json::to_string(&evidence)
                            .map_err(|_| LibraryError::InvalidOnlineCatalog)?
                    ],
                )?;
            }
        }
    }
    Ok(ReviewPage {
        rows: list(c)?,
        inspected_works: ids.len(),
        comparisons,
        skipped_buckets: skipped,
    })
}
fn candidate_context(c: &Connection) -> Result<String, LibraryError> {
    Ok(c.query_row("SELECT s.source_revision || ':' || s.generation || ':' || COALESCE((SELECT Value FROM catalog.CrawlState WHERE Key='lakomics.catalog.contentRevision'),'legacy')
        FROM online_catalog_group_state s WHERE provider='kHentai'",[],|r|r.get(0)).optional()?.unwrap_or_default())
}
#[cfg(test)]
pub(super) fn list(c: &Connection) -> Result<Vec<ReviewRow>, LibraryError> {
    rows(c, None, true)
}

/// One pair's row exactly as `list` would show it (same token), found directly so a pair
/// beyond the list bounds stays decidable.
#[cfg(test)]
fn row(c: &Connection, left: &str, right: &str) -> Result<Option<ReviewRow>, LibraryError> {
    Ok(rows(c, Some((left, right)), true)?.into_iter().next())
}

/// Pending and decided rows are bounded separately (550 each), so thousands of decisions
/// never push pending candidates out. Human decisions come before automatic merges
/// (`catalog_duplicate_sync`), which fill the rest of the decided bound. Decisions are never
/// deleted to make room.
fn rows(
    c: &Connection,
    pair: Option<(&str, &str)>,
    include_canary: bool,
) -> Result<Vec<ReviewRow>, LibraryError> {
    let (left, right) = pair.unzip();
    let read =
        |sql: &str| -> Result<Vec<(String, String, String, String, Option<String>)>, LibraryError> {
            let mut s = c.prepare(sql)?;
            let rows = s
                .query_map(params![left, right], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        };
    let mut raw = read("SELECT d.left_anchor,d.right_anchor,d.decision,d.evidence,NULL FROM online_catalog_review_decisions d
        WHERE ?1 IS NULL OR (d.left_anchor=?1 AND d.right_anchor=?2)
        ORDER BY EXISTS(SELECT 1 FROM catalog_duplicate_pairs p WHERE p.left_work_id=d.left_anchor
            AND p.right_work_id=d.right_anchor AND p.origin='auto'),1,2 LIMIT 550")?;
    if include_canary {
        raw.extend(read("SELECT left_anchor,right_anchor,'pending',evidence,source_revision FROM online_catalog_review_candidates c
        WHERE NOT EXISTS(SELECT 1 FROM online_catalog_review_decisions d WHERE d.left_anchor=c.left_anchor AND d.right_anchor=c.right_anchor)
        AND (?1 IS NULL OR (c.left_anchor=?1 AND c.right_anchor=?2))
        ORDER BY 1,2 LIMIT 550")?);
    }
    raw.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    raw.into_iter()
        .map(|(a, b, state, json, source)| {
            let evidence: ReviewEvidence =
                serde_json::from_str(&json).map_err(|_| LibraryError::InvalidOnlineCatalog)?;
            make_row(c, a, b, state, evidence, source)
        })
        .collect()
}

fn make_row(
    c: &Connection,
    a: String,
    b: String,
    state: String,
    mut evidence: ReviewEvidence,
    source: Option<String>,
) -> Result<ReviewRow, LibraryError> {
    let revision = candidate_context(c)?;
    let left = work(c, &evidence.left.work_id).ok();
    let right = work(c, &evidence.right.work_id).ok();
    let mut actionable = left.is_some() && right.is_some();
    if let Some(w) = left {
        evidence.left = w;
    }
    if let Some(w) = right {
        evidence.right = w;
    }
    if state == "pending" {
        actionable &=
            source.as_deref() == Some(revision.as_str()) && evidence.algorithm == ALGORITHM;
    }
    // Bind the action to the exact evidence/context shown to the human,
    // including replacement candidates generated in another window.
    let token_input = serde_json::to_vec(&(&a, &b, &state, &evidence, &source, &revision))
        .map_err(|_| LibraryError::InvalidOnlineCatalog)?;
    let review_token = Sha256::digest(token_input)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(ReviewRow {
        review_token,
        left_anchor: a,
        right_anchor: b,
        state,
        evidence,
        actionable,
    })
}
#[cfg(test)]
pub(super) fn decide(c: &Connection, q: &ReviewDecision) -> Result<(), LibraryError> {
    let row =
        row(c, &q.left_anchor, &q.right_anchor)?.ok_or(LibraryError::OnlineCatalogWorkNotFound)?;
    decide_row(c, q, row)
}

fn decide_row(c: &Connection, q: &ReviewDecision, row: ReviewRow) -> Result<(), LibraryError> {
    if q.left_anchor >= q.right_anchor
        || !["confirm", "falsePositive", "split"].contains(&q.decision.as_str())
    {
        return Err(LibraryError::InvalidOnlineCatalog);
    }
    let revision = catalog_groups::ensure_membership(c)?;
    // Reject stale candidates and prevent an ordinary confirm from undoing a veto.
    if !row.actionable
        || row.review_token != q.review_token
        || !(row.state == "pending" && ["confirm", "falsePositive"].contains(&q.decision.as_str())
            || row.state == "confirm" && q.decision == "split")
    {
        return Err(LibraryError::InvalidOnlineCatalog);
    }
    if row.state == "pending" && human_decisions(c)? >= HUMAN_DECISIONS {
        return Err(LibraryError::InvalidOnlineCatalog);
    }
    if q.decision != "confirm" {
        // Split only this pair out of a set that automatic merges hold together.
        super::catalog_duplicate_sync::withdraw_auto_links(
            c,
            &q.left_anchor,
            &q.right_anchor,
            &revision,
        )?;
    }
    c.execute("INSERT INTO online_catalog_review_decisions VALUES(?1,?2,?3,?4,?5) ON CONFLICT(left_anchor,right_anchor) DO UPDATE SET decision=excluded.decision,evidence=excluded.evidence,reviewed_at=excluded.reviewed_at",
        params![q.left_anchor,q.right_anchor,q.decision,serde_json::to_string(&row.evidence).map_err(|_|LibraryError::InvalidOnlineCatalog)?,chrono::Utc::now().to_rfc3339()])?;
    // A person decided here: automation stops owning (and never re-confirms) this pair.
    c.execute("UPDATE catalog_duplicate_pairs SET human=1,origin=NULL,desired=NULL,applied=1,blocked=NULL,
        report=CASE WHEN report='pending' THEN 'dropped' ELSE report END,updated_at=?3
        WHERE left_work_id=?1 AND right_work_id=?2",
        params![q.left_anchor, q.right_anchor, chrono::Utc::now().to_rfc3339()])?;
    catalog_groups::rebuild(c, &revision)?;
    if q.decision == "confirm" {
        let same:bool=c.query_row("SELECT a.group_id=b.group_id FROM online_catalog_group_members a JOIN online_catalog_group_members b ON b.provider=a.provider WHERE a.provider='kHentai' AND a.work_id=?1 AND b.work_id=?2",params![q.left_anchor,q.right_anchor],|r|r.get(0))?;
        if !same {
            return Err(LibraryError::InvalidOnlineCatalog);
        } // caller rolls back all changes
    }
    Ok(())
}
impl Library {
    fn catalog_review_cache_path(&self) -> std::path::PathBuf {
        self.root.join(".cache/catalog-review/queue-v1.json")
    }

    pub fn catalog_review_count(&self) -> Result<usize, LibraryError> {
        let mut cache = self
            .catalog_review_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let path = self.catalog_review_cache_path();
        cache.load(&path);
        let mut reader = self.catalog_read_connection()?;
        let tx = reader.transaction()?;
        cache.candidates(&tx)?;
        if let Some(count) = cache.count {
            return Ok(count);
        }
        // No decision history, evidence refresh or review tokens are needed by Home.
        let count = if human_decisions(&tx)? >= HUMAN_DECISIONS {
            0
        } else {
            cache.found.len()
        };
        cache.count = Some(count);
        cache.persist(&path);
        Ok(count)
    }

    pub fn list_catalog_review(&self) -> Result<ReviewPage, LibraryError> {
        let mut cache = self
            .catalog_review_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let path = self.catalog_review_cache_path();
        cache.load(&path);
        let mut reader = self.catalog_read_connection()?;
        let tx = reader.transaction()?;
        let page = whole_catalog_page(&tx, &mut cache)?;
        cache.persist(&path);
        Ok(page)
    }
    pub fn generate_catalog_review(&self) -> Result<ReviewPage, LibraryError> {
        self.list_catalog_review()
    }
    pub fn decide_catalog_review(&self, query: ReviewDecision) -> Result<(), LibraryError> {
        {
            let cache = self
                .catalog_review_cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let _guard = self
                .catalog_file_lock
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut c = self.connection()?;
            super::catalog_preparation::attach_catalog_readonly(&c, &self.root)?;
            let tx = c.transaction()?;
            let row = queue_decision_row(&tx, &cache, &query)?;
            decide_row(&tx, &query, row)?;
            tx.commit()?;
        }
        self.request_catalog_preparation();
        Ok(())
    }
}

#[cfg(test)]
#[path = "catalog_review_tests.rs"]
mod tests;
