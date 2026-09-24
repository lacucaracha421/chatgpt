//! Read-only review feed over the disposable S36 shadow cache.
//!
//! The screen behind this module asks the user to judge assets the shadow
//! scorer called `automatic` or `recommended`. Judgments go through the normal
//! manual decision path (`record_character_decisions`); nothing here writes to
//! the shadow cache or the library, and shadow rows never become evidence.
use super::{
    characters::{Error, Result},
    Library,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

const MAX_PAGE: u32 = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowReviewQuery {
    #[serde(default)]
    pub offset: u32,
    pub limit: u32,
    /// `doubtful`: existing automatic acceptances that S36 does not support.
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowReviewItem {
    pub asset_id: String,
    pub content_hash: String,
    pub original_name: String,
    pub width: u32,
    pub height: u32,
    pub target_id: String,
    pub target_name: String,
    pub target_fingerprint: String,
    pub reference_asset_ids: Vec<String>,
    pub verdict: String,
    pub origin: String,
    pub knn3: Option<f64>,
    pub native_outcome: String,
    pub scored_at: String,
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerdictCounts {
    pub pending: u32,
    pub accepted: u32,
    pub rejected: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowReviewSummary {
    pub automatic: VerdictCounts,
    pub recommended: VerdictCounts,
    pub by_origin: BTreeMap<String, TierCounts>,
    /// Only filled in `doubtful` mode.
    pub doubtful: VerdictCounts,
}

impl Default for ShadowReviewSummary {
    fn default() -> Self {
        Self {
            automatic: VerdictCounts::default(),
            recommended: VerdictCounts::default(),
            doubtful: VerdictCounts::default(),
            by_origin: BTreeMap::from([
                ("live".into(), TierCounts::default()),
                ("backfill".into(), TierCounts::default()),
            ]),
        }
    }
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TierCounts {
    pub automatic: VerdictCounts,
    pub recommended: VerdictCounts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowReviewPage {
    pub items: Vec<ShadowReviewItem>,
    pub next_offset: Option<u32>,
    pub policy_version: Option<String>,
    pub summary: ShadowReviewSummary,
}

struct ShadowRow {
    asset_id: String,
    content_hash: String,
    target_id: String,
    knn3: Option<f64>,
    verdict: String,
    native_outcome: String,
    scored_at: String,
    origin: String,
}

/// The S36 shadow cache opened read-only, or `None` when it does not exist or has no
/// `scores` table yet.
fn open_shadow_cache(root: &Path) -> Result<Option<Connection>> {
    let mut path = root.to_path_buf();
    for part in [".cache", "characters", "s36_shadow.sqlite"] {
        path.push(part);
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(Error::Invalid("Shadow cache must not contain symlinks"));
        }
    }
    if !path.is_file() {
        return Ok(None);
    }
    let open = || -> rusqlite::Result<(Connection, bool)> {
        let c = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        c.busy_timeout(std::time::Duration::from_millis(100))?;
        let has_table = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='scores')",
            [],
            |r| r.get(0),
        )?;
        Ok((c, has_table))
    };
    let (c, has_table) = match open() {
        // A writer stopped mid-transaction (e.g. the app restarted during history
        // scoring) leaves a hot journal that only a writable connection can roll back.
        // The cache owner opens it once to recover, then this read stays read-only.
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ReadOnly => {
            drop(super::character_shadow::Cache::open(root)?);
            open()?
        }
        result => result?,
    };
    Ok(has_table.then_some(c))
}

/// The newest `scored_at` in the S36 shadow cache: a cheap change marker for the mobile
/// candidate feed. `None` when there is no cache.
pub(crate) fn shadow_cache_scored_marker(root: &Path) -> Result<Option<String>> {
    let Some(c) = open_shadow_cache(root)? else {
        return Ok(None);
    };
    Ok(c.query_row("SELECT MAX(scored_at) FROM scores", [], |r| r.get(0))?)
}

/// Rows of the newest policy version with a reviewable verdict, or `None`
/// when the cache does not exist. The cache is opened read-only.
fn shadow_rows(root: &Path, doubtful: bool) -> Result<Option<(String, Vec<ShadowRow>)>> {
    let Some(c) = open_shadow_cache(root)? else {
        return Ok(None);
    };
    let origin = if super::character_shadow::cache_has_origin(&c)? {
        "origin"
    } else {
        "'live'"
    };
    let Some(version) = c
        .query_row(
            "SELECT policy_version FROM scores GROUP BY policy_version ORDER BY MAX(scored_at) DESC, policy_version DESC LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    else {
        return Ok(None);
    };
    let mut rows = c
        .prepare(&format!(
            "SELECT asset_id,content_hash,target_id,knn3,verdict,native_outcome,scored_at,{origin} FROM scores
             WHERE policy_version=?1 AND verdict IN {}",
            if doubtful { "('recommended','none')" } else { "('automatic','recommended')" }
        ))?
        .query_map([&version], |r| {
            Ok(ShadowRow {
                asset_id: r.get(0)?,
                content_hash: r.get(1)?,
                target_id: r.get(2)?,
                knn3: r.get(3)?,
                verdict: r.get(4)?,
                native_outcome: r.get(5)?,
                scored_at: r.get(6)?,
                origin: r.get(7)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows
        .iter()
        .any(|row| !matches!(row.origin.as_str(), "live" | "backfill"))
    {
        return Err(Error::Invalid("Unknown S36 shadow origin"));
    }
    use sha2::{Digest, Sha256};
    rows.sort_by_cached_key(|row| {
        (
            row.verdict != "automatic",
            Sha256::digest(format!("{}|{}|{}", version, row.asset_id, row.target_id)).to_vec(),
            row.asset_id.clone(),
            row.target_id.clone(),
        )
    });
    Ok(Some((version, rows)))
}

struct TargetInfo {
    name: String,
    enabled: bool,
    fingerprint: String,
    reference_asset_ids: Vec<String>,
}

/// Every pending item of one review list, in review order, with its summary.
///
/// The page command slices this list; the mobile candidate feed exports it whole, so the
/// shadow cache and the per-pair decision checks are scanned once per list, not per page.
#[derive(Debug, Clone, PartialEq)]
pub struct ShadowReviewItems {
    pub items: Vec<ShadowReviewItem>,
    pub policy_version: Option<String>,
    pub summary: ShadowReviewSummary,
}

fn shadow_review_mode(mode: Option<&str>) -> Result<bool> {
    match mode {
        None | Some("candidates") => Ok(false),
        Some("doubtful") => Ok(true),
        Some(_) => Err(Error::Invalid("알 수 없는 S36 확인 목록입니다.")),
    }
}

impl Library {
    pub fn character_shadow_review_page(
        &self,
        query: ShadowReviewQuery,
    ) -> Result<ShadowReviewPage> {
        shadow_review_mode(query.mode.as_deref())?;
        if query.limit == 0 || query.limit > MAX_PAGE {
            return Err(Error::Invalid("한 번에 1~200개 항목을 불러올 수 있습니다."));
        }
        let all = self.shadow_review_items(query.mode.as_deref())?;
        let start = (query.offset as usize).min(all.items.len());
        let end = start.saturating_add(query.limit as usize).min(all.items.len());
        Ok(ShadowReviewPage {
            next_offset: (end < all.items.len()).then(|| query.offset + query.limit),
            items: all.items[start..end].to_vec(),
            policy_version: all.policy_version,
            summary: all.summary,
        })
    }

    /// All pending items of the `candidates` (default) or `doubtful` list.
    pub(crate) fn shadow_review_items(&self, mode: Option<&str>) -> Result<ShadowReviewItems> {
        let doubtful = shadow_review_mode(mode)?;
        let mut page = ShadowReviewItems {
            items: Vec::new(),
            policy_version: None,
            summary: ShadowReviewSummary::default(),
        };
        let Some((version, rows)) = shadow_rows(&self.root, doubtful)? else {
            return Ok(page);
        };
        page.policy_version = Some(version);
        let c = self.connection()?;
        // Pairs the native pass already accepted automatically come after new findings
        // and are labelled as such; each group keeps the stable pseudo-random order.
        // (Backfill rows recorded "none" as the native outcome for them.)
        let rows = {
            let mut native = c.prepare(
                "SELECT decision FROM character_decisions
                 WHERE target_id=?1 AND source_asset_id=?2 AND origin<>'manual'
                 ORDER BY sequence DESC LIMIT 1",
            )?;
            let mut keyed = Vec::with_capacity(rows.len());
            for (index, mut row) in rows.into_iter().enumerate() {
                let classified = native
                    .query_row(params![row.target_id, row.asset_id], |r| {
                        r.get::<_, String>(0)
                    })
                    .optional()?
                    .as_deref()
                    == Some("accepted");
                if classified && row.native_outcome == "none" {
                    row.native_outcome = "accepted_automatic".into();
                }
                if doubtful && !classified {
                    continue;
                }
                keyed.push(((row.verdict != "automatic", classified, index), row));
            }
            keyed.sort_by_key(|(key, _)| *key);
            keyed.into_iter().map(|(_, row)| row).collect::<Vec<_>>()
        };
        let mut targets: BTreeMap<String, Option<TargetInfo>> = BTreeMap::new();
        let mut asset_statement = c.prepare(
            "SELECT original_name,width,height FROM assets
             WHERE id=?1 AND content_hash=?2 AND status='normal' AND media_kind='image'",
        )?;
        let mut decision_statement = c.prepare(
            "SELECT decision,created_at FROM character_decisions
             WHERE target_id=?1 AND source_asset_id=?2 AND origin='manual'
             ORDER BY sequence DESC LIMIT 1",
        )?;
        for row in rows {
            let origin_tiers = page
                .summary
                .by_origin
                .get_mut(&row.origin)
                .ok_or(Error::Stale)?;
            let origin_counts = if row.verdict == "automatic" {
                &mut origin_tiers.automatic
            } else {
                &mut origin_tiers.recommended
            };
            let counts = match row.verdict.as_str() {
                _ if doubtful => &mut page.summary.doubtful,
                "automatic" => &mut page.summary.automatic,
                _ => &mut page.summary.recommended,
            };
            let decision: Option<(String, String)> = decision_statement
                .query_row(params![row.target_id, row.asset_id], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .optional()?;
            match decision.as_ref().map(|(d, at)| (d.as_str(), at.as_str())) {
                Some(("cleared", _)) | None => {}
                Some((decision, at)) => {
                    if at > row.scored_at.as_str() {
                        if decision == "accepted" {
                            counts.accepted += 1;
                            if !doubtful {
                                origin_counts.accepted += 1;
                            }
                        } else {
                            counts.rejected += 1;
                            if !doubtful {
                                origin_counts.rejected += 1;
                            }
                        }
                    }
                    continue;
                }
            }
            let asset: Option<(String, i64, i64)> = asset_statement
                .query_row(params![row.asset_id, row.content_hash], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .optional()?;
            let Some((original_name, width, height)) = asset else {
                continue;
            };
            let target = match targets.entry(row.target_id.clone()) {
                std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::btree_map::Entry::Vacant(entry) => {
                    let info = match self.read_character_target(&c, &row.target_id) {
                        Ok(target) => Some(TargetInfo {
                            name: target.display_name.clone(),
                            enabled: target.enabled,
                            fingerprint: target.fingerprint.clone(),
                            reference_asset_ids: target
                                .usable_references()
                                .filter_map(|r| r.asset_id.clone())
                                .collect(),
                        }),
                        Err(Error::NotFound) => None,
                        Err(error) => return Err(error),
                    };
                    entry.insert(info)
                }
            };
            let Some(target) = target.as_ref().filter(|t| t.enabled) else {
                continue;
            };
            counts.pending += 1;
            if !doubtful {
                origin_counts.pending += 1;
            }
            page.items.push(ShadowReviewItem {
                asset_id: row.asset_id,
                content_hash: row.content_hash,
                original_name,
                width: u32::try_from(width).unwrap_or(0),
                height: u32::try_from(height).unwrap_or(0),
                target_id: row.target_id,
                target_name: target.name.clone(),
                target_fingerprint: target.fingerprint.clone(),
                reference_asset_ids: target.reference_asset_ids.iter().take(4).cloned().collect(),
                verdict: row.verdict,
                origin: row.origin,
                knn3: row.knn3,
                native_outcome: row.native_outcome,
                scored_at: row.scored_at,
            });
        }
        Ok(page)
    }
}

/// How close one character is to being classified by S36, from reviewed S36
/// automatic candidates (newest policy) and the manual "accepted" examples.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct S36Readiness {
    pub target_id: String,
    /// Automatic candidates judged after scoring.
    pub reviewed: u32,
    pub wrong: u32,
    /// Manual acceptances for this character (S36's positive examples).
    pub examples: u32,
    /// `ready`, `collecting`, `hold` or `keep`.
    pub status: String,
}

pub const READY_REVIEWED: u32 = 30;
pub const READY_EXAMPLES: u32 = 50;

pub(super) fn readiness_status(reviewed: u32, wrong: u32, examples: u32) -> &'static str {
    if wrong >= 4 {
        "keep"
    } else if wrong >= 2 {
        "hold"
    } else if reviewed >= READY_REVIEWED && examples >= READY_EXAMPLES {
        "ready"
    } else {
        "collecting"
    }
}

impl Library {
    /// Read-only: the shadow cache and the library decisions of one series.
    pub fn character_s36_readiness(&self, series_id: &str) -> Result<Vec<S36Readiness>> {
        let rows = shadow_rows(&self.root, false)?
            .map(|(_, rows)| rows)
            .unwrap_or_default();
        let c = self.connection()?;
        let targets = c
            .prepare(
                "SELECT id FROM character_targets WHERE series_classification_id=?1 ORDER BY id",
            )?
            .query_map([series_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut decision = c.prepare(
            "SELECT decision,created_at FROM character_decisions
             WHERE target_id=?1 AND source_asset_id=?2 AND origin='manual'
             ORDER BY sequence DESC LIMIT 1",
        )?;
        let mut result = Vec::with_capacity(targets.len());
        for target in targets {
            let (mut reviewed, mut wrong) = (0u32, 0u32);
            for row in rows
                .iter()
                .filter(|r| r.target_id == target && r.verdict == "automatic")
            {
                let judged: Option<(String, String)> = decision
                    .query_row(params![row.target_id, row.asset_id], |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })
                    .optional()?;
                if let Some((value, at)) = judged {
                    if at.as_str() > row.scored_at.as_str() && value != "cleared" {
                        reviewed += 1;
                        wrong += u32::from(value == "rejected");
                    }
                }
            }
            let examples: u32 = c.query_row(
                "SELECT COUNT(*) FROM (SELECT d.source_asset_id,
                   (SELECT x.decision FROM character_decisions x WHERE x.target_id=d.target_id AND x.source_asset_id=d.source_asset_id ORDER BY x.sequence DESC LIMIT 1) AS latest
                 FROM character_decisions d WHERE d.target_id=?1 AND d.origin='manual' GROUP BY d.source_asset_id)
                 WHERE latest='accepted'",
                [&target],
                |r| r.get(0),
            )?;
            let status = readiness_status(reviewed, wrong, examples).to_string();
            result.push(S36Readiness {
                target_id: target,
                reviewed,
                wrong,
                examples,
                status,
            });
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::super::characters::{tests::Fixture, DecisionKind, DecisionRequest, Target};
    use super::*;

    fn insert(root: &Path, rows: &[(&str, &str, &str, f64, &str, &str, &str)]) {
        super::super::character_shadow::Cache::open(root).unwrap();
        let c = Connection::open(root.join(".cache/characters/s36_shadow.sqlite")).unwrap();
        for (asset, target, verdict, knn3, version, outcome, scored_at) in rows {
            c.execute(
                "INSERT OR REPLACE INTO scores(asset_id,content_hash,target_id,knn3,verdict,policy_version,feature_id,native_outcome,native_at,scored_at,prior_manual_rejections)
                 VALUES(?1,?2,?3,?4,?5,?6,'feature',?7,?8,?8,100)",
                params![asset, content_hash(asset), target, knn3, verdict, version, outcome, scored_at],
            )
            .unwrap();
        }
    }

    fn content_hash(asset: &str) -> String {
        use sha2::Digest;
        sha2::Sha256::digest(asset.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// One more series-level image so two pending pairs can be judged manually.
    fn series_asset(f: &Fixture, id: &str) {
        let original = format!("assets/{id}.png");
        let thumbnail = format!("thumbnails/{id}.webp");
        std::fs::write(f.temp.path().join(&original), id.as_bytes()).unwrap();
        std::fs::write(f.temp.path().join(&thumbnail), id.as_bytes()).unwrap();
        let c = f.library.connection().unwrap();
        c.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status)
            VALUES(?1,?2,'image',?1,?3,?4,7,3,2,'2026-09-08','normal')", params![id, content_hash(id), original, thumbnail]).unwrap();
        c.execute(
            "INSERT INTO asset_classifications VALUES(?1,?2)",
            params![id, f.series],
        )
        .unwrap();
    }

    fn decide(f: &Fixture, target: &Target, asset: &str, decision: DecisionKind) {
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
    }

    fn page(f: &Fixture, offset: u32, limit: u32) -> ShadowReviewPage {
        f.library
            .character_shadow_review_page(ShadowReviewQuery {
                offset,
                limit,
                mode: None,
            })
            .unwrap()
    }

    #[test]
    fn character_shadow_review_missing_cache_is_empty() {
        let f = Fixture::new();
        let page = page(&f, 0, 50);
        assert!(page.items.is_empty());
        assert_eq!(page.policy_version, None);
        assert_eq!(page.summary, ShadowReviewSummary::default());
        assert!(!f
            .temp
            .path()
            .join(".cache/characters/s36_shadow.sqlite")
            .exists());
        assert!(f
            .library
            .character_shadow_review_page(ShadowReviewQuery {
                offset: 0,
                limit: 0,
                mode: None
            })
            .is_err());
    }

    #[test]
    fn character_shadow_review_puts_already_classified_pairs_after_new_findings() {
        let f = Fixture::new();
        let target = f.ready("Shadow");
        let root = f.temp.path();
        for id in ["new-1", "new-2", "done-1", "done-2"] {
            series_asset(&f, id);
        }
        let rows: Vec<_> = ["done-1", "new-1", "done-2", "new-2"]
            .iter()
            .map(|id| {
                (
                    *id,
                    target.id.as_str(),
                    "automatic",
                    0.12,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                )
            })
            .collect();
        insert(root, &rows);
        let c = f.library.connection().unwrap();
        for id in ["done-1", "done-2"] {
            c.execute(
                "INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
                 VALUES(?1,?2,?2,?3,'accepted',?4,'{}','automatic','2026-09-20T00:00:00Z')",
                params![target.id, id, content_hash(id), target.fingerprint],
            )
            .unwrap();
        }
        drop(c);
        let items = page(&f, 0, 50).items;
        let order: Vec<_> = items.iter().map(|i| i.asset_id.as_str()).collect();
        assert_eq!(order.len(), 4);
        assert!(
            order[..2].iter().all(|id| id.starts_with("new-")),
            "{order:?}"
        );
        assert!(
            order[2..].iter().all(|id| id.starts_with("done-")),
            "{order:?}"
        );
        assert!(items[..2].iter().all(|i| i.native_outcome == "none"));
        assert!(items[2..]
            .iter()
            .all(|i| i.native_outcome == "accepted_automatic"));
        // Pagination follows the same order.
        assert_eq!(page(&f, 2, 1).items[0].asset_id, order[2]);
    }

    #[test]
    fn character_shadow_review_filters_orders_and_counts() {
        let f = Fixture::new();
        let target = f.ready("Shadow");
        let other = f.ready("Other");
        let disabled = f.ready("Disabled");
        f.library
            .save_character_target(super::super::characters::TargetDraft {
                id: Some(disabled.id.clone()),
                expected_revision: Some(disabled.revision),
                series_classification_id: disabled.series_classification_id.clone(),
                linked_classification_id: disabled.linked_classification_id.clone(),
                display_name: disabled.display_name.clone(),
                description: String::new(),
                thumbnail_asset_id: None,
                enabled: false,
            })
            .unwrap();
        let root = f.temp.path();
        series_asset(&f, "asset-8");
        insert(
            root,
            &[
                (
                    "asset-5",
                    &target.id,
                    "recommended",
                    0.14,
                    "v1",
                    "recommended",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-8",
                    &target.id,
                    "automatic",
                    0.12,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-5",
                    &other.id,
                    "automatic",
                    0.10,
                    "v1",
                    "accepted_automatic",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-6",
                    &other.id,
                    "none",
                    0.30,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-5",
                    &disabled.id,
                    "automatic",
                    0.05,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-6",
                    "missing-target",
                    "automatic",
                    0.05,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-7",
                    &target.id,
                    "automatic",
                    0.05,
                    "v1",
                    "none",
                    "2026-09-23T01:00:00Z",
                ),
                (
                    "asset-0",
                    &target.id,
                    "automatic",
                    0.01,
                    "v0",
                    "none",
                    "2026-09-22T00:00:00Z",
                ),
            ],
        );
        // asset-7 does not exist; the other target's asset-5 row gets a stale hash.
        let c = Connection::open(root.join(".cache/characters/s36_shadow.sqlite")).unwrap();
        c.execute(
            "UPDATE scores SET content_hash='f' WHERE asset_id='asset-5' AND target_id=?1",
            [&other.id],
        )
        .unwrap();
        drop(c);

        let first = page(&f, 0, 50);
        assert_eq!(first.policy_version.as_deref(), Some("v1"));
        let pairs: Vec<(&str, &str, &str)> = first
            .items
            .iter()
            .map(|i| {
                (
                    i.asset_id.as_str(),
                    i.target_id.as_str(),
                    i.verdict.as_str(),
                )
            })
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("asset-8", target.id.as_str(), "automatic"),
                ("asset-5", target.id.as_str(), "recommended"),
            ]
        );
        assert_eq!(first.items[0].target_name, "Shadow");
        assert_eq!(first.items[0].target_fingerprint, target.fingerprint);
        assert_eq!(first.items[0].reference_asset_ids.len(), 4);
        assert_eq!(first.items[0].knn3, Some(0.12));
        assert_eq!(first.items[0].native_outcome, "none");
        assert_eq!(first.items[0].original_name, "asset-8");
        assert_eq!((first.items[0].width, first.items[0].height), (3, 2));
        assert_eq!(first.next_offset, None);
        assert_eq!(
            first.summary.automatic,
            VerdictCounts {
                pending: 1,
                accepted: 0,
                rejected: 0
            }
        );
        assert_eq!(
            first.summary.recommended,
            VerdictCounts {
                pending: 1,
                accepted: 0,
                rejected: 0
            }
        );

        // Pagination by offset over the pending list.
        let second = page(&f, 0, 1);
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].asset_id, "asset-8");
        assert_eq!(second.next_offset, Some(1));
        assert_eq!(second.summary.automatic.pending, 1);
        let third = page(&f, 1, 1);
        assert_eq!(third.items[0].asset_id, "asset-5");
        assert_eq!(third.next_offset, None);

        // A manual decision after scoring removes the pair and counts as reviewed.
        decide(&f, &target, "asset-8", DecisionKind::Accepted);
        decide(&f, &target, "asset-5", DecisionKind::Rejected);
        let reviewed = page(&f, 0, 50);
        assert!(reviewed.items.is_empty());
        assert_eq!(
            reviewed.summary.automatic,
            VerdictCounts {
                pending: 0,
                accepted: 1,
                rejected: 0
            }
        );
        assert_eq!(
            reviewed.summary.recommended,
            VerdictCounts {
                pending: 0,
                accepted: 0,
                rejected: 1
            }
        );

        // Clearing the decision returns the pair to the queue.
        decide(&f, &target, "asset-5", DecisionKind::Cleared);
        let cleared = page(&f, 0, 50);
        assert_eq!(cleared.items.len(), 1);
        assert_eq!(cleared.items[0].asset_id, "asset-5");
        assert_eq!(
            cleared.summary.recommended,
            VerdictCounts {
                pending: 1,
                accepted: 0,
                rejected: 0
            }
        );

        // A decision made before the shadow row was scored neither pends nor counts.
        let c = Connection::open(root.join(".cache/characters/s36_shadow.sqlite")).unwrap();
        c.execute(
            "UPDATE scores SET scored_at='2099-01-01T00:00:00Z' WHERE asset_id='asset-8' AND target_id=?1",
            [&target.id],
        )
        .unwrap();
        drop(c);
        let earlier = page(&f, 0, 50);
        assert_eq!(earlier.summary.automatic, VerdictCounts::default());
    }
    #[test]
    fn character_shadow_review_stable_shuffle_pages_and_origin_counts() {
        use sha2::{Digest, Sha256};
        let f = Fixture::new();
        let target = f.ready("Shuffle");
        for i in 8..20 {
            let id = format!("asset-{i}");
            series_asset(&f, &id);
            insert(
                f.temp.path(),
                &[(
                    &id,
                    &target.id,
                    if i < 17 { "automatic" } else { "recommended" },
                    i as f64 / 100.0,
                    "v1",
                    "none",
                    "2020-01-01T00:00:00Z",
                )],
            );
        }
        let cache =
            Connection::open(f.temp.path().join(".cache/characters/s36_shadow.sqlite")).unwrap();
        cache
            .execute(
                "UPDATE scores SET origin='backfill' WHERE asset_id IN ('asset-8','asset-18')",
                [],
            )
            .unwrap();
        let full = page(&f, 0, 50);
        let mut expected = (8..20).map(|i| format!("asset-{i}")).collect::<Vec<_>>();
        expected.sort_by_key(|id| {
            (
                id[6..].parse::<u32>().unwrap() >= 17,
                Sha256::digest(format!("v1|{id}|{}", target.id)).to_vec(),
            )
        });
        assert_eq!(
            full.items
                .iter()
                .map(|i| i.asset_id.clone())
                .collect::<Vec<_>>(),
            expected
        );
        let parts = (0..4)
            .flat_map(|i| page(&f, i * 3, 3).items.into_iter().map(|row| row.asset_id))
            .collect::<Vec<_>>();
        assert_eq!(parts, expected);
        // Scores changing within their tier cannot change the review order.
        cache.execute("UPDATE scores SET knn3=1-knn3", []).unwrap();
        assert_eq!(
            page(&f, 0, 50)
                .items
                .iter()
                .map(|i| i.asset_id.clone())
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(full.summary.by_origin["backfill"].automatic.pending, 1);
        assert_eq!(full.summary.by_origin["live"].automatic.pending, 8);
        decide(&f, &target, "asset-8", DecisionKind::Accepted);
        decide(&f, &target, "asset-18", DecisionKind::Rejected);
        let reviewed = page(&f, 0, 50);
        assert_eq!(reviewed.summary.by_origin["backfill"].automatic.accepted, 1);
        assert_eq!(
            reviewed.summary.by_origin["backfill"].recommended.rejected,
            1
        );
        assert_eq!(reviewed.summary.by_origin["live"].automatic.accepted, 0);
    }
    #[test]
    fn character_shadow_review_legacy_origin_is_live_without_migration() {
        let f = Fixture::new();
        let target = f.ready("Legacy");
        insert(
            f.temp.path(),
            &[(
                "asset-5",
                &target.id,
                "automatic",
                0.1,
                "v1",
                "none",
                "2020-01-01T00:00:00Z",
            )],
        );
        let cache =
            Connection::open(f.temp.path().join(".cache/characters/s36_shadow.sqlite")).unwrap();
        cache
            .execute_batch("ALTER TABLE scores DROP COLUMN origin; PRAGMA user_version=0;")
            .unwrap();
        let page = page(&f, 0, 50);
        assert_eq!(page.items[0].origin, "live");
        assert_eq!(page.summary.by_origin["live"].automatic.pending, 1);
        assert!(!super::super::character_shadow::cache_has_origin(&cache).unwrap());
    }
    #[test]
    fn s36_readiness_status_thresholds() {
        assert_eq!(readiness_status(30, 1, 50), "ready");
        assert_eq!(readiness_status(29, 0, 80), "collecting");
        assert_eq!(readiness_status(40, 0, 49), "collecting");
        assert_eq!(readiness_status(12, 2, 80), "hold");
        assert_eq!(readiness_status(30, 4, 80), "keep");
    }
}
