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

impl Library {
    pub fn character_review_page(&self, query: ReviewQuery) -> Result<ReviewPage> {
        self.character_review_page_mode(query, false)
            .map(|(page, _)| page)
    }

    /// Advisory badge only. Displaying/accepting evidence still verifies source bytes.
    pub fn character_review_pending(&self, series_id: &str, target_id: &str) -> Result<bool> {
        self.character_review_page_mode(
            ReviewQuery {
                series_id: series_id.into(),
                target_id: Some(target_id.into()),
                filter: "recommended".into(),
                after: None,
                limit: 1,
            },
            true,
        )
        .map(|(_, found)| found)
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
        let mut rows = Vec::new();
        let mut after = query.after.clone();
        const INPUT_BATCH: usize = 256;
        loop {
            let (inputs, decisions, durable_assets, failed_jobs) = {
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
                let durable = connection.prepare("SELECT DISTINCT e.asset_id FROM character_autotag_evidence e
                    JOIN character_autotag_predictions p ON p.evidence_id=e.id
                    JOIN character_autotag_jobs j ON j.asset_id=e.asset_id AND j.source_generation=e.source_generation
                    WHERE e.asset_id IN (SELECT value FROM json_each(?2)) AND p.series_id=?1 AND j.state<>'superseded'")?
                    .query_map(params![query.series_id,ids],|r|r.get::<_,String>(0))?
                    .collect::<std::result::Result<std::collections::BTreeSet<_>,_>>()?;
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
                if durable_assets.contains(&input.id) {
                    let connection = self.connection()?;
                    for prediction in &mut predictions {
                        // Explicit active/manual scans retain precedence when they have a row.
                        if prediction.evidence.is_some() {
                            continue;
                        }
                        if let Some(id) = super::super::character_autotag::latest_evidence(
                            &connection,
                            &input.id,
                            &prediction.target_id,
                        )? {
                            if let Some((status, row)) =
                                super::super::character_autotag::evidence_row(
                                    &connection,
                                    &id,
                                    &prediction.target_id,
                                )?
                            {
                                prediction.scan_id = Some(id);
                                prediction.runtime_fingerprint = status.runtime_fingerprint;
                                prediction.state = row.state;
                                prediction.evidence = row.evidence;
                                prediction.error = row.error;
                                if status.target_fingerprint != prediction.target_fingerprint
                                    || row.content_hash != input.hash
                                    || !ready[&prediction.target_id]
                                {
                                    prediction.state = "stale".into();
                                    prediction.evidence = None;
                                }
                            }
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
                let Ok(asset) = self.get_asset(&input.id) else {
                    continue;
                };
                rows.push(ReviewRow { asset, predictions });
                if rows.len() == query.limit {
                    let next_cursor = (index + 1 < inputs.len() || inputs.len() == INPUT_BATCH)
                        .then(|| input.id.clone());
                    return Ok((ReviewPage { rows, next_cursor }, true));
                }
            }
            after = inputs.last().map(|input| input.id.clone());
            if inputs.len() < INPUT_BATCH {
                break;
            }
        }
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
