use super::*;
use crate::library::models::AssetSummary;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewQuery {
    pub series_id: String,
    pub target_id: Option<String>,
    pub filter: String,
    pub after: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prediction {
    pub target_id: String,
    pub target_name: String,
    pub target_fingerprint: String,
    pub scan_id: Option<String>,
    pub runtime_fingerprint: Option<String>,
    pub state: String,
    pub decision: Option<String>,
    pub evidence: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRow {
    pub asset: AssetSummary,
    pub predictions: Vec<Prediction>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPage {
    pub rows: Vec<ReviewRow>,
    pub next_cursor: Option<String>,
}

const REVIEW_PENDING_MEMORY_SQL: &str = r#"
WITH RECURSIVE scope(id) AS (
    SELECT id FROM classification_entries WHERE id=?1
    UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id
), ancestors(id,parent_id) AS (
    SELECT id,parent_id FROM classification_entries WHERE id=?1
    UNION ALL SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id
), candidates(id,content_hash) AS (
    SELECT key,value FROM json_each(?3)
)
SELECT EXISTS(
    SELECT 1 FROM candidates c JOIN assets a ON a.id=c.id
    WHERE a.status='normal' AND a.media_kind='image' AND a.content_hash=c.content_hash
      AND (
        EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope))
        OR (a.id IN (SELECT value FROM json_each(?4))
            AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM ancestors WHERE parent_id IS NULL)))
      )
      AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.target_id=?2 AND r.asset_id=a.id)
      AND COALESCE((SELECT d.decision FROM character_decisions d WHERE d.target_id=?2 AND d.source_asset_id=a.id ORDER BY d.sequence DESC LIMIT 1),'') NOT IN ('accepted','rejected')
    LIMIT 1
)
"#;

const REVIEW_PENDING_DURABLE_SQL: &str = r#"
WITH RECURSIVE scope(id) AS (
    SELECT id FROM classification_entries WHERE id=?1
    UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id
), ancestors(id,parent_id) AS (
    SELECT id,parent_id FROM classification_entries WHERE id=?1
    UNION ALL SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id
)
SELECT EXISTS(
    SELECT 1
    FROM character_autotag_predictions p
    JOIN character_autotag_evidence e ON e.id=p.evidence_id
    JOIN character_autotag_jobs j ON j.asset_id=e.asset_id AND j.source_generation=e.source_generation
    JOIN assets a ON a.id=e.asset_id AND a.content_hash=e.content_hash
    WHERE p.series_id=?1 AND p.target_id=?2 AND p.target_fingerprint=?3
      AND j.state<>'superseded' AND a.status='normal' AND a.media_kind='image'
      AND json_extract(p.result_json,'$.state')='recommended'
      AND NOT EXISTS(
        SELECT 1 FROM character_autotag_evidence newer_e
        JOIN character_autotag_predictions newer_p ON newer_p.evidence_id=newer_e.id AND newer_p.target_id=?2
        WHERE newer_e.asset_id=e.asset_id AND newer_e.source_generation=e.source_generation
          AND newer_e.generation>e.generation
      )
      AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.target_id=?2 AND r.asset_id=a.id)
      AND COALESCE((SELECT d.decision FROM character_decisions d WHERE d.target_id=?2 AND d.source_asset_id=a.id ORDER BY d.sequence DESC LIMIT 1),'') NOT IN ('accepted','rejected')
      AND (
        EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope))
        OR EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM ancestors WHERE parent_id IS NULL))
      )
    LIMIT 1
)
"#;

const REVIEW_RECOMMENDED_MEMORY_SQL: &str = r#"
WITH RECURSIVE scope(id) AS (
    SELECT id FROM classification_entries WHERE id=?1
    UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id
), ancestors(id,parent_id) AS (
    SELECT id,parent_id FROM classification_entries WHERE id=?1
    UNION ALL SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id
), candidates(id,content_hash) AS (
    SELECT key,value FROM json_each(?3)
)
SELECT a.id,a.content_hash,a.relative_path,
       (SELECT d.decision FROM character_decisions d
        WHERE d.target_id=?2 AND d.source_asset_id=a.id
        ORDER BY d.sequence DESC LIMIT 1)
FROM candidates c JOIN assets a ON a.id=c.id AND a.content_hash=c.content_hash
WHERE a.status='normal' AND a.media_kind='image'
  AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.target_id=?2 AND r.asset_id=a.id)
  AND (
    EXISTS(SELECT 1 FROM asset_classifications ac
      WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope))
    OR (
      EXISTS(SELECT 1 FROM asset_classifications ac
        WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM ancestors WHERE parent_id IS NULL))
      AND (
        ?4
        OR EXISTS(SELECT 1 FROM character_autotag_evidence e
          JOIN character_autotag_predictions p ON p.evidence_id=e.id
          JOIN character_autotag_jobs j ON j.asset_id=e.asset_id AND j.source_generation=e.source_generation
          WHERE e.asset_id=a.id AND p.series_id=?1 AND j.state<>'superseded')
        OR EXISTS(SELECT 1 FROM character_autotag_jobs j WHERE j.asset_id=a.id AND j.state='failed')
      )
    )
  )
ORDER BY a.id
"#;

const REVIEW_RECOMMENDED_DURABLE_SQL: &str = r#"
WITH RECURSIVE scope(id) AS (
    SELECT id FROM classification_entries WHERE id=?1
    UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id
), ancestors(id,parent_id) AS (
    SELECT id,parent_id FROM classification_entries WHERE id=?1
    UNION ALL SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id
)
SELECT e.id,e.asset_id,e.content_hash,a.relative_path,p.result_json,p.target_fingerprint,e.runtime_fingerprint,
       (SELECT d.decision FROM character_decisions d
        WHERE d.target_id=?2 AND d.source_asset_id=a.id
        ORDER BY d.sequence DESC LIMIT 1)
FROM character_autotag_predictions p
JOIN character_autotag_evidence e ON e.id=p.evidence_id
JOIN character_autotag_jobs j ON j.asset_id=e.asset_id AND j.source_generation=e.source_generation
JOIN assets a ON a.id=e.asset_id AND a.content_hash=e.content_hash
WHERE p.series_id=?1 AND p.target_id=?2 AND p.target_fingerprint=?3
  AND json_extract(p.result_json,'$.state')='recommended'
  AND j.state<>'superseded' AND a.status='normal' AND a.media_kind='image'
  AND a.id>COALESCE(?4,'')
  AND NOT EXISTS(
    SELECT 1 FROM character_autotag_evidence newer_e
    JOIN character_autotag_predictions newer_p
      ON newer_p.evidence_id=newer_e.id AND newer_p.target_id=?2
    WHERE newer_e.asset_id=e.asset_id AND newer_e.source_generation=e.source_generation
      AND newer_e.generation>e.generation
  )
  AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.target_id=?2 AND r.asset_id=a.id)
  AND COALESCE((SELECT d.decision FROM character_decisions d
      WHERE d.target_id=?2 AND d.source_asset_id=a.id
      ORDER BY d.sequence DESC LIMIT 1),'') NOT IN ('accepted','rejected')
  AND (
    EXISTS(SELECT 1 FROM asset_classifications ac
      WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope))
    OR EXISTS(SELECT 1 FROM asset_classifications ac
      WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM ancestors WHERE parent_id IS NULL))
  )
ORDER BY a.id
LIMIT ?5
"#;

impl Library {
    pub fn character_review_page(&self, query: ReviewQuery) -> Result<ReviewPage> {
        if query.filter == "recommended" {
            if let Some(target_id) = query.target_id.as_deref() {
                return self.character_recommended_page(
                    &query.series_id,
                    target_id,
                    query.after.as_deref(),
                    query.limit,
                );
            }
        }
        self.character_review_page_mode(query, false)
            .map(|(page, _)| page)
    }

    fn character_recommended_page(
        &self,
        series_id: &str,
        target_id: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<ReviewPage> {
        if !(1..=80).contains(&limit) {
            return Err(Error::Invalid("검토 조회 조건이 올바르지 않습니다."));
        }
        let target = self.get_character_target(target_id)?;
        if target.series_classification_id.as_deref() != Some(series_id)
            || self.reference_inputs(&target).is_err()
        {
            return Ok(ReviewPage {
                rows: Vec::new(),
                next_cursor: None,
            });
        }

        let memory = {
            let state = self
                .character_scan
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state
                .status
                .as_ref()
                .filter(|status| status.target_id == target.id)
                .map(|status| (status, &state.results))
                .or_else(|| {
                    state
                        .previous
                        .get(&target.id)
                        .map(|(status, rows)| (status, rows))
                })
                .filter(|(status, _)| status.target_fingerprint == target.fingerprint)
                .map(|(status, rows)| {
                    let rows = rows
                        .values()
                        .filter(|row| row.evidence.is_some())
                        .map(|row| (row.asset_id.clone(), row.clone()))
                        .collect::<BTreeMap<_, _>>();
                    (status.clone(), rows)
                })
        };

        let mut memory_overrides = std::collections::BTreeSet::new();
        let mut memory_candidates = BTreeMap::<String, (ScanInput, Prediction)>::new();
        if let Some((status, rows)) = memory {
            if !rows.is_empty() {
                let hashes = rows
                    .iter()
                    .map(|(id, row)| (id, &row.content_hash))
                    .collect::<BTreeMap<_, _>>();
                let connection = self.connection()?;
                let encoded = serde_json::to_string(&hashes)?;
                let mut statement = connection.prepare(REVIEW_RECOMMENDED_MEMORY_SQL)?;
                let valid = statement
                    .query_map(
                        params![series_id, target_id, encoded, status.automatic],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, Option<String>>(3)?,
                            ))
                        },
                    )?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                drop(statement);
                drop(connection);
                for (asset_id, content_hash, path, decision) in valid {
                    memory_overrides.insert(asset_id.clone());
                    let Some(row) = rows.get(&asset_id) else {
                        continue;
                    };
                    if row.state != "recommended"
                        || matches!(decision.as_deref(), Some("accepted" | "rejected"))
                        || after.is_some_and(|cursor| asset_id.as_str() <= cursor)
                    {
                        continue;
                    }
                    let input = ScanInput {
                        id: asset_id.clone(),
                        hash: content_hash,
                        path,
                    };
                    if self.verify_input(&input).is_err() {
                        continue;
                    }
                    memory_candidates.insert(
                        asset_id,
                        (
                            input,
                            Prediction {
                                target_id: target.id.clone(),
                                target_name: target.display_name.clone(),
                                target_fingerprint: target.fingerprint.clone(),
                                scan_id: Some(status.id.clone()),
                                runtime_fingerprint: status.runtime_fingerprint.clone(),
                                state: row.state.clone(),
                                decision,
                                evidence: row.evidence.clone(),
                                error: row.error.clone(),
                            },
                        ),
                    );
                    if memory_candidates.len() > limit {
                        break;
                    }
                }
            }
        }

        let mut durable_after = after.map(str::to_owned);
        let mut durable_candidates = BTreeMap::<String, (ScanInput, Prediction)>::new();
        let fetch_limit = (limit + 1).max(32);
        while durable_candidates.len() <= limit {
            let rows = {
                let connection = self.connection()?;
                let mut statement = connection.prepare(REVIEW_RECOMMENDED_DURABLE_SQL)?;
                let rows = statement
                    .query_map(
                        params![
                            series_id,
                            target_id,
                            target.fingerprint,
                            durable_after,
                            fetch_limit as i64
                        ],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, String>(4)?,
                                row.get::<_, String>(5)?,
                                row.get::<_, String>(6)?,
                                row.get::<_, Option<String>>(7)?,
                            ))
                        },
                    )?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                rows
            };
            if rows.is_empty() {
                break;
            }
            let fetched = rows.len();
            for (
                evidence_id,
                asset_id,
                content_hash,
                path,
                result_json,
                target_fingerprint,
                runtime_fingerprint,
                decision,
            ) in rows
            {
                durable_after = Some(asset_id.clone());
                if memory_overrides.contains(&asset_id)
                    || durable_candidates.contains_key(&asset_id)
                {
                    continue;
                }
                let row: ScanResult = serde_json::from_str(&result_json)?;
                if row.state != "recommended"
                    || row.asset_id != asset_id
                    || row.content_hash != content_hash
                {
                    continue;
                }
                let input = ScanInput {
                    id: asset_id.clone(),
                    hash: content_hash,
                    path,
                };
                if self.verify_input(&input).is_err() {
                    continue;
                }
                durable_candidates.insert(
                    asset_id,
                    (
                        input,
                        Prediction {
                            target_id: target.id.clone(),
                            target_name: target.display_name.clone(),
                            target_fingerprint,
                            scan_id: Some(evidence_id),
                            runtime_fingerprint: Some(runtime_fingerprint),
                            state: row.state,
                            decision,
                            evidence: row.evidence,
                            error: row.error,
                        },
                    ),
                );
                if durable_candidates.len() > limit {
                    break;
                }
            }
            if durable_candidates.len() > limit || fetched < fetch_limit {
                break;
            }
        }

        let mut combined = memory_candidates;
        for (id, candidate) in durable_candidates {
            combined.entry(id).or_insert(candidate);
        }
        let mut pending = combined
            .into_iter()
            .map(|(id, (_, prediction))| (id, vec![prediction]))
            .collect::<Vec<_>>();
        let has_more = pending.len() > limit;
        if has_more {
            pending.truncate(limit);
        }
        let next_cursor = has_more
            .then(|| pending.last().map(|(id, _)| id.clone()))
            .flatten();
        let rows = materialize_review_rows(self, pending)?;
        Ok(ReviewPage { rows, next_cursor })
    }

    /// Advisory badge only. Keep this metadata-only and bounded: opening a character
    /// folder must not materialize the full review page just to answer one boolean.
    pub fn character_review_pending(&self, series_id: &str, target_id: &str) -> Result<bool> {
        let connection = self.connection()?;
        let target = self.read_character_target(&connection, target_id)?;
        if target.series_classification_id.as_deref() != Some(series_id) || !target.ready {
            return Ok(false);
        }
        self.review_pending_in(&connection, &target)
    }

    fn review_pending_in(
        &self,
        connection: &rusqlite::Connection,
        target: &Target,
    ) -> Result<bool> {
        let Some(series_id) = target.series_classification_id.as_deref() else {
            return Ok(false);
        };
        let (memory_candidates, automatic_root_candidates) = {
            let state = self
                .character_scan
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let pair = state
                .status
                .as_ref()
                .filter(|status| status.target_id == target.id)
                .map(|status| (status, &state.results))
                .or_else(|| {
                    state
                        .previous
                        .get(&target.id)
                        .map(|(status, rows)| (status, rows))
                });
            let memory_candidates = pair
                .filter(|(status, _)| status.target_fingerprint == target.fingerprint)
                .map(|(_, rows)| {
                    rows.values()
                        .filter(|row| row.state == "recommended")
                        .map(|row| (row.asset_id.clone(), row.content_hash.clone()))
                        .collect::<std::collections::BTreeMap<_, _>>()
                })
                .unwrap_or_default();
            let automatic_root_candidates = state
                .previous
                .values()
                .map(|(status, rows)| (status, rows))
                .chain(state.status.as_ref().map(|status| (status, &state.results)))
                .filter(|(status, _)| status.automatic && status.target_id == target.id)
                .flat_map(|(_, rows)| rows.keys())
                .filter(|id| memory_candidates.contains_key(*id))
                .cloned()
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            (memory_candidates, automatic_root_candidates)
        };

        if !memory_candidates.is_empty() {
            let memory_json = serde_json::to_string(&memory_candidates)?;
            let roots_json = serde_json::to_string(&automatic_root_candidates)?;
            let found: bool = connection.query_row(
                REVIEW_PENDING_MEMORY_SQL,
                params![series_id, target.id, memory_json, roots_json],
                |row| row.get(0),
            )?;
            if found {
                return Ok(true);
            }
        }

        Ok(connection.query_row(
            REVIEW_PENDING_DURABLE_SQL,
            params![series_id, target.id, target.fingerprint],
            |row| row.get(0),
        )?)
    }

    /// Advisory badges for every ready character at once. The sidebar lists all
    /// characters, so one round trip beats one call per row. Results are keyed by
    /// target ID and only include characters that actually have pending review.
    pub fn character_review_pending_map(&self) -> Result<std::collections::BTreeMap<String, bool>> {
        let connection = self.connection()?;
        let ids = connection
            .prepare("SELECT id FROM character_targets ORDER BY display_name COLLATE NOCASE, id")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut pending = std::collections::BTreeMap::new();
        for id in ids {
            let target = self.read_character_target(&connection, &id)?;
            if !target.ready {
                continue;
            }
            if self.review_pending_in(&connection, &target)? {
                pending.insert(target.id.clone(), true);
            }
        }
        Ok(pending)
    }

    fn character_review_page_mode(
        &self,
        query: ReviewQuery,
        advisory: bool,
    ) -> Result<(ReviewPage, bool)> {
        if !(1..=80).contains(&query.limit)
            || ![
                "all",
                "recommended",
                "unmatched",
                "multiple",
                "confirmed",
                "pending",
                "error",
                "rejected",
            ]
            .contains(&query.filter.as_str())
        {
            return Err(Error::Invalid("검토 조회 조건이 올바르지 않습니다."));
        }
        let targets: Vec<_> = match &query.target_id {
            Some(id) => vec![self.get_character_target(id)?],
            None => self.list_character_targets()?,
        }
        .into_iter()
        .filter(|t| {
            t.series_classification_id.as_deref() == Some(&query.series_id)
                && query.target_id.as_ref().is_none_or(|id| id == &t.id)
        })
        .collect();
        if targets.is_empty() {
            return Ok((
                ReviewPage {
                    rows: Vec::new(),
                    next_cursor: None,
                },
                false,
            ));
        }
        let root_candidates = {
            let state = self
                .character_scan
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state
                .previous
                .values()
                .map(|(s, r)| (s, r))
                .chain(state.status.as_ref().map(|s| (s, &state.results)))
                .filter(|(s, _)| s.automatic && targets.iter().any(|t| t.id == s.target_id))
                .flat_map(|(_, rows)| rows.keys().cloned())
                .collect::<std::collections::BTreeSet<_>>()
        };
        let root_candidates = serde_json::to_string(&root_candidates)?;
        let ready: BTreeMap<_, _> = targets
            .iter()
            .map(|t| {
                (
                    t.id.clone(),
                    if advisory {
                        t.ready
                    } else {
                        self.reference_inputs(t).is_ok()
                    },
                )
            })
            .collect();
        let mut pending_rows = Vec::new();
        let mut after = query.after.clone();
        const INPUT_BATCH: usize = 256;
        loop {
            let (inputs, decisions, durable_predictions, failed_jobs) = {
                let connection = self.connection()?;
                // Bound both candidate materialization and related evidence/decision queries.
                // Root-category candidates must belong to this series' root, just as in
                // candidate_image_mode; ordinary assets remain in the recursive series scope.
                let mut statement = connection.prepare("WITH RECURSIVE scope(id) AS (
                    SELECT id FROM classification_entries WHERE id=?1 UNION
                    SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id),
                    ancestors(id,parent_id) AS (SELECT id,parent_id FROM classification_entries WHERE id=?1 UNION ALL
                    SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id)
                    SELECT a.id,a.content_hash,a.relative_path FROM assets a
                    WHERE a.status='normal' AND a.media_kind='image' AND a.id > COALESCE(?2, '')
                    AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND (
                        ac.classification_id IN (SELECT id FROM scope) OR (
                        ac.classification_id IN (SELECT id FROM ancestors WHERE parent_id IS NULL) AND (
                            a.id IN (SELECT value FROM json_each(?3)) OR
                            EXISTS(SELECT 1 FROM character_autotag_evidence e
                                JOIN character_autotag_predictions p ON p.evidence_id=e.id
                                JOIN character_autotag_jobs j ON j.asset_id=e.asset_id AND j.source_generation=e.source_generation
                                WHERE e.asset_id=a.id AND p.series_id=?1 AND j.state<>'superseded') OR
                            EXISTS(SELECT 1 FROM character_autotag_jobs j WHERE j.asset_id=a.id AND j.state='failed')))))
                    ORDER BY a.id LIMIT ?4")?;
                let inputs = statement
                    .query_map(
                        params![query.series_id, after, root_candidates, INPUT_BATCH as i64],
                        |r| {
                            Ok(ScanInput {
                                id: r.get(0)?,
                                hash: r.get(1)?,
                                path: r.get(2)?,
                            })
                        },
                    )?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                let ids = serde_json::to_string(&inputs.iter().map(|i| &i.id).collect::<Vec<_>>())?;
                let durable_rows = connection.prepare("SELECT e.id,e.asset_id,p.target_id,p.result_json,p.target_fingerprint,e.runtime_fingerprint
                    FROM character_autotag_evidence e
                    JOIN character_autotag_predictions p ON p.evidence_id=e.id
                    JOIN character_autotag_jobs j ON j.asset_id=e.asset_id AND j.source_generation=e.source_generation
                    JOIN assets a ON a.id=e.asset_id AND a.content_hash=e.content_hash AND a.status='normal'
                    WHERE e.asset_id IN (SELECT value FROM json_each(?2)) AND p.series_id=?1 AND j.state<>'superseded'
                    AND (?3 IS NULL OR p.target_id=?3)
                    ORDER BY e.asset_id,p.target_id,e.generation DESC,e.id DESC")?
                    .query_map(params![query.series_id,ids,query.target_id],|r|Ok((
                        r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,
                        r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?
                    )))?
                    .collect::<std::result::Result<Vec<_>,_>>()?;
                let mut durable = BTreeMap::new();
                for (
                    evidence_id,
                    asset_id,
                    target_id,
                    result_json,
                    target_fingerprint,
                    runtime_fingerprint,
                ) in durable_rows
                {
                    let key = (asset_id, target_id);
                    if durable.contains_key(&key) {
                        continue;
                    }
                    durable.insert(
                        key,
                        (
                            evidence_id,
                            serde_json::from_str::<ScanResult>(&result_json)?,
                            target_fingerprint,
                            runtime_fingerprint,
                        ),
                    );
                }
                let failed = connection
                    .prepare(
                        "SELECT asset_id,error FROM character_autotag_jobs
                    WHERE state='failed' AND asset_id IN (SELECT value FROM json_each(?1))",
                    )?
                    .query_map([&ids], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
                    })?
                    .collect::<std::result::Result<BTreeMap<_, _>, _>>()?;
                let decisions = connection.prepare("SELECT d.target_id,d.source_asset_id,d.decision FROM character_decisions d
                    JOIN character_targets t ON t.id=d.target_id WHERE t.series_classification_id=?1
                    AND (?3 IS NULL OR d.target_id=?3) AND d.source_asset_id IN (SELECT value FROM json_each(?2))
                    AND NOT EXISTS(SELECT 1 FROM character_decisions n WHERE n.target_id=d.target_id AND n.source_asset_id=d.source_asset_id AND n.sequence>d.sequence)")?
                    .query_map(params![query.series_id,ids,query.target_id],|r|Ok(((r.get::<_,String>(0)?,r.get::<_,String>(1)?),r.get::<_,String>(2)?)))?
                    .collect::<std::result::Result<BTreeMap<_,_>,_>>()?;
                (inputs, decisions, durable, failed)
            };
            if inputs.is_empty() {
                break;
            }
            for (index, input) in inputs.iter().enumerate() {
                // Reference selection is a separate UI, not a recommendation to approve itself.
                if targets.iter().any(|t| {
                    t.references
                        .iter()
                        .any(|r| r.asset_id.as_deref() == Some(&input.id))
                }) {
                    continue;
                }
                let source_current = advisory || self.verify_input(input).is_ok();
                let mut predictions = {
                    let state = self
                        .character_scan
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    targets
                        .iter()
                        .map(|target| {
                            let pair = state
                                .status
                                .as_ref()
                                .filter(|s| s.target_id == target.id)
                                .map(|s| (s, &state.results))
                                .or_else(|| state.previous.get(&target.id).map(|(s, r)| (s, r)));
                            let mut prediction = Prediction {
                                target_id: target.id.clone(),
                                target_name: target.display_name.clone(),
                                target_fingerprint: target.fingerprint.clone(),
                                scan_id: None,
                                runtime_fingerprint: None,
                                state: "pending".into(),
                                decision: decisions
                                    .get(&(target.id.clone(), input.id.clone()))
                                    .cloned(),
                                evidence: None,
                                error: None,
                            };
                            if let Some((status, results)) = pair {
                                prediction.scan_id = Some(status.id.clone());
                                prediction.runtime_fingerprint = status.runtime_fingerprint.clone();
                                if let Some(row) = results.get(&input.id) {
                                    prediction.state = row.state.clone();
                                    prediction.evidence = row.evidence.clone();
                                    prediction.error = row.error.clone();
                                    if status.target_fingerprint != target.fingerprint
                                        || row.content_hash != input.hash
                                        || !ready[&target.id]
                                        || !source_current
                                    {
                                        prediction.state = "stale".into();
                                        prediction.evidence = None;
                                    }
                                }
                            }
                            prediction
                        })
                        .collect::<Vec<_>>()
                };
                for prediction in &mut predictions {
                    // Explicit active/manual scans retain precedence when they have a row.
                    if prediction.evidence.is_some() {
                        continue;
                    }
                    if let Some((evidence_id, row, target_fingerprint, runtime_fingerprint)) =
                        durable_predictions.get(&(input.id.clone(), prediction.target_id.clone()))
                    {
                        prediction.scan_id = Some(evidence_id.clone());
                        prediction.runtime_fingerprint = Some(runtime_fingerprint.clone());
                        prediction.state = row.state.clone();
                        prediction.evidence = row.evidence.clone();
                        prediction.error = row.error.clone();
                        if target_fingerprint != &prediction.target_fingerprint
                            || row.content_hash != input.hash
                            || !ready[&prediction.target_id]
                        {
                            prediction.state = "stale".into();
                            prediction.evidence = None;
                        }
                    }
                }
                if let Some(error) = failed_jobs.get(&input.id) {
                    for prediction in &mut predictions {
                        if prediction.evidence.is_none() {
                            prediction.state = "error".into();
                            prediction.error = error.clone();
                        }
                    }
                }
                if predictions.is_empty() || !matches_filter(&predictions, &query.filter) {
                    continue;
                }
                if advisory {
                    return Ok((
                        ReviewPage {
                            rows: Vec::new(),
                            next_cursor: None,
                        },
                        true,
                    ));
                }
                if predictions.iter().any(|p| p.evidence.is_some())
                    && self.verify_input(input).is_err()
                {
                    for prediction in &mut predictions {
                        prediction.state = "stale".into();
                        prediction.evidence = None;
                    }
                    if !matches_filter(&predictions, &query.filter) {
                        continue;
                    }
                }
                pending_rows.push((input.id.clone(), predictions));
                if pending_rows.len() == query.limit {
                    let next_cursor = (index + 1 < inputs.len() || inputs.len() == INPUT_BATCH)
                        .then(|| input.id.clone());
                    let rows = materialize_review_rows(self, std::mem::take(&mut pending_rows))?;
                    return Ok((ReviewPage { rows, next_cursor }, true));
                }
            }
            after = inputs.last().map(|input| input.id.clone());
            if inputs.len() < INPUT_BATCH {
                break;
            }
        }
        let rows = materialize_review_rows(self, pending_rows)?;
        let found = !rows.is_empty();
        Ok((
            ReviewPage {
                rows,
                next_cursor: None,
            },
            found,
        ))
    }
}

fn materialize_review_rows(
    library: &Library,
    pending: Vec<(String, Vec<Prediction>)>,
) -> Result<Vec<ReviewRow>> {
    let ids = pending.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
    let assets = {
        let connection = library.connection()?;
        super::super::query::asset_summaries_by_ids(&connection, &ids)?
    };
    Ok(assets
        .into_iter()
        .zip(pending)
        .map(|(asset, (_, predictions))| ReviewRow { asset, predictions })
        .collect())
}

fn matches_filter(predictions: &[Prediction], filter: &str) -> bool {
    let candidates = predictions
        .iter()
        .filter(|p| {
            p.state == "recommended"
                && !matches!(p.decision.as_deref(), Some("accepted" | "rejected"))
        })
        .count();
    match filter {
        "recommended" => candidates > 0,
        "multiple" => candidates > 1,
        "confirmed" => predictions
            .iter()
            .any(|p| p.decision.as_deref() == Some("accepted")),
        "unmatched" => {
            !predictions.is_empty()
                && predictions.iter().all(|p| {
                    p.decision.as_deref() == Some("rejected")
                        || (p.state == "unmatched" && p.decision.as_deref() != Some("accepted"))
                })
        }
        "pending" => {
            predictions.is_empty()
                || predictions
                    .iter()
                    .any(|p| matches!(p.state.as_str(), "pending" | "stale"))
        }
        "rejected" => predictions
            .iter()
            .any(|p| p.decision.as_deref() == Some("rejected")),
        "error" => predictions.iter().any(|p| p.state == "error"),
        _ => true,
    }
}
