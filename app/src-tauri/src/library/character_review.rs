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
        let targets: Vec<_> = self
            .list_character_targets()?
            .into_iter()
            .filter(|t| {
                t.series_classification_id.as_deref() == Some(&query.series_id)
                    && query.target_id.as_ref().is_none_or(|id| id == &t.id)
            })
            .collect();
        let root_candidates = {
            let state = self.character_scan.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            state.previous.values().map(|(s,r)| (s,r)).chain(state.status.as_ref().map(|s| (s,&state.results)))
                .filter(|(s,_)| s.automatic && targets.iter().any(|t| t.id == s.target_id))
                .flat_map(|(_,rows)| rows.keys().cloned()).collect::<std::collections::BTreeSet<_>>()
        };
        let (inputs, decisions) = {
            let connection = self.connection()?;
            let root_candidates = root_candidates.into_iter().filter(|id|
                super::super::character_hub::candidate_image_mode(&connection,&query.series_id,id,true).is_ok())
                .collect::<Vec<_>>();
            let mut statement = connection.prepare("WITH RECURSIVE scope(id) AS (
                SELECT id FROM classification_entries WHERE id=?1 UNION
                SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id)
                SELECT a.id,a.content_hash,a.relative_path FROM assets a
                WHERE a.status='normal' AND a.media_kind='image' AND (?2 IS NULL OR a.id>?2)
                AND (EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope)) OR a.id IN (SELECT value FROM json_each(?3))) ORDER BY a.id")?;
            let inputs = statement
                .query_map(params![query.series_id, query.after, serde_json::to_string(&root_candidates)?], |r| {
                    Ok(ScanInput {
                        id: r.get(0)?,
                        hash: r.get(1)?,
                        path: r.get(2)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let mut statement = connection.prepare("SELECT d.target_id,d.source_asset_id,d.decision FROM character_decisions d
                JOIN character_targets t ON t.id=d.target_id WHERE t.series_classification_id=?1
                AND NOT EXISTS(SELECT 1 FROM character_decisions n WHERE n.target_id=d.target_id AND n.source_asset_id=d.source_asset_id AND n.sequence>d.sequence)")?;
            let decisions = statement
                .query_map([&query.series_id], |r| {
                    Ok((
                        (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                        r.get::<_, String>(2)?,
                    ))
                })?
                .collect::<std::result::Result<BTreeMap<_, _>, _>>()?;
            (inputs, decisions)
        };
        let ready: BTreeMap<_, _> = targets
            .iter()
            .map(|t| (t.id.clone(), self.reference_inputs(t).is_ok()))
            .collect();
        let mut rows = Vec::new();
        let mut next_cursor = None;
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
            if predictions.is_empty() || !matches_filter(&predictions, &query.filter) {
                continue;
            }
            if predictions.iter().any(|p| p.evidence.is_some()) && self.verify_input(input).is_err()
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
                if index + 1 < inputs.len() {
                    next_cursor = Some(input.id.clone());
                }
                break;
            }
        }
        Ok(ReviewPage { rows, next_cursor })
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
        "rejected" => predictions.iter().any(|p| p.decision.as_deref() == Some("rejected")),
        "error" => predictions.iter().any(|p| p.state == "error"),
        _ => true,
    }
}
