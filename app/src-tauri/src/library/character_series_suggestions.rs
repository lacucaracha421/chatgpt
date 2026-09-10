use super::{
    character_autotag::{self, Cause},
    character_scan::ScanResult,
    characters::{Error, Result},
    models::{AssetSummary, SetAssetClassification},
    query::asset_summaries_by_ids,
    Library,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

const DISCOVERY_BATCH: usize = 500;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesSuggestion {
    pub asset: AssetSummary,
    pub series_id: String,
    pub series_name: String,
    pub target_id: String,
    pub target_name: String,
    pub target_count: usize,
    pub matched_references: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesSuggestionPage {
    pub items: Vec<SeriesSuggestion>,
    pub unscanned_count: u64,
    pub pending_count: u64,
}

#[derive(Debug)]
struct Candidate {
    asset_id: String,
    series_id: String,
    series_name: String,
    target_id: String,
    target_name: String,
    result: ScanResult,
}

fn validate_root(connection: &Connection, root_id: &str) -> Result<()> {
    let root = connection
        .query_row(
            "SELECT kind,parent_id FROM classification_entries WHERE id=?1",
            [root_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    if !matches!(root, Some((ref kind, None)) if kind == "root") {
        return Err(Error::Invalid("최상위 분류에서만 작품 후보를 찾을 수 있습니다."));
    }
    let has_series: bool = connection.query_row(
        "WITH RECURSIVE descendants(id) AS (
            SELECT id FROM classification_entries WHERE id=?1
            UNION ALL SELECT c.id FROM classification_entries c JOIN descendants d ON c.parent_id=d.id)
         SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id IN (SELECT id FROM descendants) AND classification_id<>?1)",
        [root_id], |row| row.get(0))?;
    if !has_series {
        return Err(Error::Invalid("이 분류 아래에 등록된 작품이 없습니다."));
    }
    Ok(())
}

fn discovery_counts(connection: &Connection, root_id: &str) -> Result<(u64, u64)> {
    let direct = "a.status='normal' AND a.media_kind='image'
        AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id=?1)
        AND NOT EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id<>?1)";
    let pending: i64 = connection.query_row(
        &format!("SELECT COUNT(*) FROM assets a WHERE {direct}
            AND EXISTS(SELECT 1 FROM character_autotag_jobs j WHERE j.asset_id=a.id AND j.state IN ('pending','processing'))"),
        [root_id], |row| row.get(0))?;
    let unscanned: i64 = connection.query_row(
        &format!("SELECT COUNT(*) FROM assets a WHERE {direct}
            AND NOT EXISTS(SELECT 1 FROM character_autotag_jobs j WHERE j.asset_id=a.id AND j.state IN ('pending','processing'))
            AND NOT EXISTS(SELECT 1 FROM character_autotag_jobs j
                JOIN character_autotag_evidence e ON e.asset_id=j.asset_id AND e.generation=j.generation
                    AND e.source_generation=j.source_generation AND e.content_hash=a.content_hash
                WHERE j.asset_id=a.id AND j.state='completed')"),
        [root_id], |row| row.get(0))?;
    Ok((u64::try_from(unscanned).unwrap_or(0), u64::try_from(pending).unwrap_or(0)))
}

fn suggestion_candidates(library: &Library, connection: &Connection, root_id: &str) -> Result<Vec<Candidate>> {
    let mut statement = connection.prepare("WITH RECURSIVE descendants(id) AS (
        SELECT id FROM classification_entries WHERE id=?1
        UNION ALL SELECT c.id FROM classification_entries c JOIN descendants d ON c.parent_id=d.id)
        SELECT a.id,p.series_id,s.name,p.target_id,t.display_name,p.target_fingerprint,p.result_json
        FROM assets a JOIN asset_classifications ac ON ac.asset_id=a.id AND ac.classification_id=?1
        JOIN character_autotag_jobs j ON j.asset_id=a.id AND j.state='completed'
        JOIN character_autotag_evidence e ON e.asset_id=a.id AND e.generation=j.generation
            AND e.source_generation=j.source_generation AND e.content_hash=a.content_hash
        JOIN character_autotag_predictions p ON p.evidence_id=e.id
        JOIN character_targets t ON t.id=p.target_id AND t.enabled=1
        JOIN classification_entries s ON s.id=p.series_id
        WHERE a.status='normal' AND a.media_kind='image'
        AND NOT EXISTS(SELECT 1 FROM asset_classifications other WHERE other.asset_id=a.id AND other.classification_id<>?1)
        AND p.series_id<>?1 AND p.series_id IN (SELECT id FROM descendants)
        AND json_extract(p.result_json,'$.state')='recommended'
        ORDER BY a.collected_at DESC,a.id DESC,p.target_id")?;
    let rows = statement
        .query_map([root_id], |row| {
            Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let reconsidering = connection
        .prepare("SELECT series_id FROM character_autotag_reconsideration")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;
    let dismissed = connection
        .prepare("SELECT asset_id,series_classification_id FROM character_series_suggestion_dismissals")?
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;
    let needed_targets = rows.iter().map(|row| row.3.clone()).collect::<BTreeSet<_>>();
    let mut current_targets = BTreeMap::new();
    for id in needed_targets {
        let target = library.read_character_target(connection, &id)?;
        current_targets.insert(id, (target.fingerprint, target.ready));
    }
    let mut candidates = Vec::new();
    let mut blocked_assets = BTreeSet::new();
    for (asset_id, series_id, series_name, target_id, target_name, fingerprint, encoded) in rows {
        if reconsidering.contains(&series_id) {
            blocked_assets.insert(asset_id);
            continue;
        }
        let Some((current_fingerprint, ready)) = current_targets.get(&target_id) else { continue; };
        if !*ready || current_fingerprint != &fingerprint {
            blocked_assets.insert(asset_id);
            continue;
        }
        if dismissed.contains(&(asset_id.clone(), series_id.clone())) { continue; }
        let rejected: Option<String> = connection.query_row(
            "SELECT decision FROM character_decisions WHERE target_id=?1 AND source_asset_id=?2 ORDER BY sequence DESC LIMIT 1",
            params![target_id, asset_id], |row| row.get(0)).optional()?;
        if matches!(rejected.as_deref(), Some("rejected" | "cleared")) { continue; }
        candidates.push(Candidate { asset_id, series_id, series_name, target_id, target_name,
            result: serde_json::from_str(&encoded)? });
    }
    candidates.retain(|candidate| !blocked_assets.contains(&candidate.asset_id));
    Ok(candidates)
}

fn candidate_distance(candidate: &Candidate) -> Option<f64> {
    candidate.result.evidence.as_ref()?.get("distance")?.as_f64().filter(|value| value.is_finite())
}

fn matched_reference_count(candidate: &Candidate) -> usize {
    let Some(evidence) = candidate.result.evidence.as_ref() else { return 0; };
    let Some(index) = evidence.get("bestQueryCrop").and_then(|value| value.as_u64()) else { return 0; };
    evidence.get("evidence").and_then(|value| value.as_array())
        .and_then(|rows| rows.get(index as usize))
        .and_then(|row| row.get("matchedReferences"))
        .and_then(|value| value.as_array())
        .map_or(0, Vec::len)
}

fn unique_series_for_asset(candidates: &[Candidate], asset_id: &str) -> Option<String> {
    let series = candidates.iter().filter(|candidate| candidate.asset_id == asset_id)
        .map(|candidate| candidate.series_id.as_str()).collect::<BTreeSet<_>>();
    (series.len() == 1).then(|| (*series.first().unwrap()).to_string())
}

impl Library {
    pub fn character_series_suggestions(&self, root_id: &str, limit: usize) -> Result<SeriesSuggestionPage> {
        if !(1..=200).contains(&limit) {
            return Err(Error::Invalid("작품 후보 조회 개수가 올바르지 않습니다."));
        }
        let connection = self.connection()?;
        validate_root(&connection, root_id)?;
        let (unscanned_count, pending_count) = discovery_counts(&connection, root_id)?;
        let candidates = suggestion_candidates(self, &connection, root_id)?;
        let mut grouped: BTreeMap<String, Vec<Candidate>> = BTreeMap::new();
        let mut order = Vec::new();
        for candidate in candidates {
            if !grouped.contains_key(&candidate.asset_id) { order.push(candidate.asset_id.clone()); }
            grouped.entry(candidate.asset_id.clone()).or_default().push(candidate);
        }
        let mut chosen = Vec::new();
        for asset_id in order {
            let Some(group) = grouped.get(&asset_id) else { continue; };
            let series = group.iter().map(|candidate| candidate.series_id.as_str()).collect::<BTreeSet<_>>();
            if series.len() != 1 { continue; }
            let Some(best) = group.iter().filter_map(|candidate| candidate_distance(candidate).map(|distance| (distance, candidate)))
                .min_by(|left, right| left.0.total_cmp(&right.0)) else { continue; };
            let target_count = group.iter().map(|candidate| candidate.target_id.as_str()).collect::<BTreeSet<_>>().len();
            chosen.push((asset_id, best.1.series_id.clone(), best.1.series_name.clone(), best.1.target_id.clone(),
                best.1.target_name.clone(), target_count, matched_reference_count(best.1)));
            if chosen.len() == limit { break; }
        }
        let asset_ids = chosen.iter().map(|row| row.0.clone()).collect::<Vec<_>>();
        let assets = asset_summaries_by_ids(&connection, &asset_ids)?;
        let items = chosen.into_iter().zip(assets).map(|((_, series_id, series_name, target_id, target_name, target_count, matched_references), asset)| SeriesSuggestion {
            asset, series_id, series_name, target_id, target_name, target_count, matched_references,
        }).collect();
        Ok(SeriesSuggestionPage { items, unscanned_count, pending_count })
    }

    pub fn queue_character_series_discovery(&self, root_id: &str) -> Result<usize> {
        let mut connection = self.connection()?;
        validate_root(&connection, root_id)?;
        let transaction = connection.transaction()?;
        let ids = transaction.prepare("SELECT a.id FROM assets a
            WHERE a.status='normal' AND a.media_kind='image'
            AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id=?1)
            AND NOT EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id<>?1)
            AND NOT EXISTS(SELECT 1 FROM character_autotag_jobs j WHERE j.asset_id=a.id AND j.state IN ('pending','processing'))
            AND NOT EXISTS(SELECT 1 FROM character_autotag_jobs j
                JOIN character_autotag_evidence e ON e.asset_id=j.asset_id AND e.generation=j.generation
                    AND e.source_generation=j.source_generation AND e.content_hash=a.content_hash
                WHERE j.asset_id=a.id AND j.state='completed')
            ORDER BY a.collected_at DESC,a.id DESC LIMIT ?2")?
            .query_map(params![root_id, DISCOVERY_BATCH as i64], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut queued = 0;
        for id in &ids {
            queued += usize::from(character_autotag::enqueue(&transaction, id, Cause::ManualScanEnrollment)?);
        }
        transaction.commit()?;
        Ok(queued)
    }

    pub fn dismiss_character_series_suggestion(&self, root_id: &str, asset_id: &str, series_id: &str) -> Result<()> {
        let connection = self.connection()?;
        validate_root(&connection, root_id)?;
        let candidates = suggestion_candidates(self, &connection, root_id)?;
        if unique_series_for_asset(&candidates, asset_id).as_deref() != Some(series_id) {
            return Err(Error::Stale);
        }
        connection.execute("INSERT INTO character_series_suggestion_dismissals(asset_id,series_classification_id,created_at)
            VALUES(?1,?2,?3) ON CONFLICT(asset_id,series_classification_id) DO NOTHING",
            params![asset_id, series_id, chrono::Utc::now().to_rfc3339()])?;
        Ok(())
    }

    pub fn accept_character_series_suggestion(&self, root_id: &str, asset_id: &str, series_id: &str) -> Result<()> {
        let mut connection = self.connection()?;
        validate_root(&connection, root_id)?;
        let candidates = suggestion_candidates(self, &connection, root_id)?;
        if unique_series_for_asset(&candidates, asset_id).as_deref() != Some(series_id) {
            return Err(Error::Stale);
        }
        let transaction = connection.transaction()?;
        Self::set_asset_classification_cause_in(
            &transaction,
            &SetAssetClassification { asset_ids: vec![asset_id.to_string()], classification_id: Some(series_id.to_string()) },
            Cause::Classification,
        )?;
        transaction.execute(
            "DELETE FROM character_series_suggestion_dismissals WHERE asset_id=?1",
            [asset_id],
        )?;
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "character_series_suggestions_tests.rs"]
mod tests;
