//! Dual-tagger preview/apply, also used after an enabled machine-local inbox import.
//! No inference jobs run here.
//! Vetoes append an automatic `cleared` decision; the existing B36 and S36
//! decision guards treat that as a durable stop, even after a later import.
//! Recommendations block automatic publication while awaiting a manual judgment.
use super::auto_tags::CONTENT_RATING_SQL;
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    characters::{Error, Result},
    models::AssetSummary,
    Library,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetCount {
    pub target_id: String,
    pub target_name: String,
    pub series_id: String,
    pub series_name: String,
    pub count: usize,
    pub sample_asset_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesCount {
    pub series_id: String,
    pub series_name: String,
    pub count: usize,
}
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Pair count (one image can belong to several targets).
    pub count: usize,
    pub targets: Vec<TargetCount>,
    pub series: Vec<SeriesCount>,
    pub sample_asset_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub preview_token: String,
    pub veto: Summary,
    /// Veto pairs protected because the image is a user-picked reference.
    pub skipped_references: Summary,
    pub recommend: Summary,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaggerReviewCounts {
    /// Pending `(target, asset)` pairs shown by the ordinary paged review.
    pub total: i64,
    pub recommendation: i64,
    pub veto: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaggerReviewEvidence {
    pub source: &'static str,
    pub reason: String,
    pub pixai_score: f64,
    pub canary_score: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaggerReviewCrop {
    pub r#box: [f64; 4],
    pub distance: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaggerReviewItem {
    pub asset: AssetSummary,
    pub series_id: String,
    pub target_id: String,
    pub target_name: String,
    pub target_fingerprint: String,
    pub evidence: TaggerReviewEvidence,
    pub crop: Option<TaggerReviewCrop>,
}

struct PendingReviewRow {
    asset: AssetSummary,
    series_id: String,
    target_id: String,
    target_name: String,
    reason: String,
    pixai_score: f64,
    canary_score: f64,
    scan_result: Option<String>,
}

/// The ordinary review page attaches this exact evidence shape to tagger predictions.
fn tagger_evidence(reason: String, pixai_score: f64, canary_score: f64) -> TaggerReviewEvidence {
    TaggerReviewEvidence {
        source: "tagger",
        reason,
        pixai_score,
        canary_score,
    }
}

/// Candidate rows and complete asset summaries are read together so the desktop tagger review
/// does not page every series. Ties on `collected_at` keep the review page's asset-id order.
const TAGGER_REVIEW_ITEMS_SQL: &str = r#"
SELECT asset.id, asset.title, asset.original_name, asset.relative_path,
       asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height,
       asset.collected_at, asset.favorite, asset.source_url, asset.media_kind,
       video.duration_ms, video.preparation_state, video.scrub_frame_count,
       asset.source_published_at, asset.creator_name, asset.creator_handle,
       asset.creator_url, asset.import_source, asset.import_batch_id,
       asset.original_modified_at,
       q.series_id, t.id, t.display_name, q.reason, q.pixai_score, q.canary_score,
       (SELECT p.result_json
        FROM character_autotag_evidence e
        CROSS JOIN character_autotag_predictions p ON p.evidence_id=e.id AND p.target_id=t.id
        CROSS JOIN character_autotag_jobs j ON j.asset_id=e.asset_id AND j.source_generation=e.source_generation
        WHERE e.asset_id=asset.id AND e.content_hash=asset.content_hash
          AND p.series_id=q.series_id AND j.state<>'superseded'
        ORDER BY e.generation DESC LIMIT 1)
, {CONTENT_RATING_SQL} AS content_rating
FROM character_tagger_pending q
JOIN character_targets t ON t.id=q.target_id
JOIN character_folder_order o ON o.target_id=t.id
JOIN assets asset ON asset.id=q.asset_id
LEFT JOIN video_assets video ON video.asset_id=asset.id
ORDER BY q.series_id, o.position, t.id, asset.collected_at DESC, asset.id
"#;

const TAGGER_REVIEW_FINGERPRINTS_SQL: &str = r#"
WITH RECURSIVE targets AS (
    SELECT * FROM character_targets WHERE id IN (SELECT value FROM json_each(?1))
), scope(target_id,id) AS (
    SELECT t.id,c.id FROM targets t JOIN classification_entries c ON c.id=t.series_classification_id
    UNION SELECT s.target_id,c.id FROM scope s JOIN classification_entries c ON c.parent_id=s.id
)
SELECT t.id,t.series_classification_id,t.enabled,t.manual_only,
       r.slot,r.asset_id,r.asset_hash,a.content_hash,a.relative_path,
       COALESCE(a.status='normal' AND a.media_kind='image' AND EXISTS(
           SELECT 1 FROM asset_classifications ac JOIN scope s ON s.id=ac.classification_id
           WHERE s.target_id=t.id AND ac.asset_id=a.id),0),
       region.asset_hash,region.baseline_fingerprint,region.bounds_json
FROM targets t
LEFT JOIN character_references r ON r.target_id=t.id
LEFT JOIN assets a ON a.id=r.asset_id
LEFT JOIN character_reference_regions region ON region.target_id=t.id AND region.asset_id=r.asset_id
ORDER BY t.id,r.slot
"#;

/// Invalid/whole-image evidence must not suggest a particular person.
fn review_crop(result: Option<&str>, width: u32, height: u32) -> Option<TaggerReviewCrop> {
    if width == 0 || height == 0 {
        return None;
    }
    let result: serde_json::Value = serde_json::from_str(result?).ok()?;
    let evidence = result.get("evidence")?;
    if evidence["wholeFallback"] == true {
        return None;
    }
    let index = usize::try_from(evidence["bestQueryCrop"].as_u64()?).ok()?;
    let bounds = evidence["queryBoxes"].as_array()?.get(index)?.as_array()?;
    if bounds.len() != 4 {
        return None;
    }
    let mut normalized = [0.; 4];
    for (i, value) in bounds.iter().enumerate() {
        let value = value.as_f64()?;
        if !value.is_finite() {
            return None;
        }
        normalized[i] = (value
            / if i % 2 == 0 {
                width as f64
            } else {
                height as f64
            })
        .clamp(0., 1.);
    }
    if normalized[0] >= normalized[2]
        || normalized[1] >= normalized[3]
        || normalized == [0., 0., 1., 1.]
    {
        return None;
    }
    let distance = evidence["distance"].as_f64().filter(|d| d.is_finite())?;
    Some(TaggerReviewCrop {
        r#box: normalized,
        distance,
    })
}

#[derive(Debug, Serialize)]
struct Pair {
    target_id: String,
    target_name: String,
    series_id: String,
    series_name: String,
    asset_id: String,
    asset_hash: String,
    pixai: f64,
    canary: f64,
    decision_sequence: Option<i64>,
}

// Each model may know different costume variants. Require at least one mapped
// character tag in EACH vocabulary and completion by BOTH models, then take each
// model's maximum over ALL mapped tags. Unprocessed assets are never negative evidence.
const PAIRS_SQL: &str = r#"
WITH known AS (
 SELECT t.id,t.display_name,t.series_classification_id,c.name
 FROM character_targets t JOIN classification_entries c ON c.id=t.series_classification_id
 WHERE EXISTS(SELECT 1 FROM character_target_tagger_tags m JOIN tagger_character_vocabulary v ON v.tag=m.tag WHERE m.target_id=t.id AND v.source='pixai')
 AND EXISTS(SELECT 1 FROM character_target_tagger_tags m JOIN tagger_character_vocabulary v ON v.tag=m.tag WHERE m.target_id=t.id AND v.source='canary')
), scored AS (
 SELECT t.*,a.id asset_id,a.content_hash,
 COALESCE((SELECT MAX(s.score) FROM character_target_tagger_tags m JOIN asset_tagger_character_scores s ON s.tag=m.tag AND s.asset_id=a.id AND s.source='pixai' WHERE m.target_id=t.id),0) pixai,
 COALESCE((SELECT MAX(s.score) FROM character_target_tagger_tags m JOIN asset_tagger_character_scores s ON s.tag=m.tag AND s.asset_id=a.id AND s.source='canary' WHERE m.target_id=t.id),0) canary,
 (SELECT MAX(d.sequence) FROM character_decisions d WHERE d.target_id=t.id AND d.source_asset_id=a.id) seq
 FROM known t CROSS JOIN asset_tagger_coverage p
 JOIN asset_tagger_coverage w ON w.asset_id=p.asset_id AND w.source='canary'
 JOIN assets a ON a.id=p.asset_id
 WHERE p.source='pixai' AND a.status='normal' AND a.media_kind='image'
 AND NOT EXISTS(SELECT 1 FROM character_tagger_candidates q WHERE q.target_id=t.id AND q.asset_id=a.id AND q.asset_hash=a.content_hash)
 AND NOT EXISTS(SELECT 1 FROM character_series_asset_exclusions x WHERE x.series_id=t.series_classification_id AND x.asset_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM asset_classifications ac JOIN character_excluded_folders f ON f.id=ac.classification_id WHERE ac.asset_id=a.id)
)
SELECT s.id,s.display_name,s.series_classification_id,s.name,s.asset_id,s.content_hash,s.pixai,s.canary,s.seq,
 CASE WHEN s.pixai<0.3 AND s.canary<0.3 THEN
   CASE WHEN EXISTS(SELECT 1 FROM character_references r WHERE r.target_id=s.id AND r.asset_id=s.asset_id)
     OR EXISTS(SELECT 1 FROM character_learned_references r WHERE r.target_id=s.id AND r.asset_id=s.asset_id AND r.provenance<>'automatic')
   THEN 'skipped_reference' ELSE 'veto' END
 ELSE 'recommendation' END
 FROM scored s LEFT JOIN character_decisions d ON d.sequence=s.seq
 WHERE (s.pixai<0.3 AND s.canary<0.3 AND d.decision='accepted' AND d.origin='automatic' AND d.asset_hash=s.content_hash)
 OR (s.pixai>=0.85 AND s.canary>=0.85 AND s.seq IS NULL
     AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.target_id=s.id AND r.asset_id=s.asset_id)
     AND NOT EXISTS(SELECT 1 FROM character_learned_references r WHERE r.target_id=s.id AND r.asset_id=s.asset_id))
 ORDER BY s.id,s.asset_id
"#;

fn summary(pairs: &[Pair]) -> Summary {
    let mut targets = BTreeMap::<String, TargetCount>::new();
    let mut series = BTreeMap::<String, SeriesCount>::new();
    let mut samples = BTreeSet::new();
    for pair in pairs {
        let t = targets
            .entry(pair.target_id.clone())
            .or_insert_with(|| TargetCount {
                target_id: pair.target_id.clone(),
                target_name: pair.target_name.clone(),
                series_id: pair.series_id.clone(),
                series_name: pair.series_name.clone(),
                count: 0,
                sample_asset_ids: Vec::new(),
            });
        t.count += 1;
        if t.sample_asset_ids.len() < 20 {
            t.sample_asset_ids.push(pair.asset_id.clone());
        }
        series
            .entry(pair.series_id.clone())
            .or_insert_with(|| SeriesCount {
                series_id: pair.series_id.clone(),
                series_name: pair.series_name.clone(),
                count: 0,
            })
            .count += 1;
        if samples.len() < 20 {
            samples.insert(pair.asset_id.clone());
        }
    }
    Summary {
        count: pairs.len(),
        targets: targets.into_values().collect(),
        series: series.into_values().collect(),
        sample_asset_ids: samples.into_iter().collect(),
    }
}

fn preview_in(c: &Connection) -> Result<(Preview, Vec<Pair>, Vec<Pair>)> {
    let mut veto = Vec::new();
    let mut skipped_references = Vec::new();
    let mut recommend = Vec::new();
    let mut statement = c.prepare(PAIRS_SQL)?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let pair = Pair {
            target_id: row.get(0)?,
            target_name: row.get(1)?,
            series_id: row.get(2)?,
            series_name: row.get(3)?,
            asset_id: row.get(4)?,
            asset_hash: row.get(5)?,
            pixai: row.get(6)?,
            canary: row.get(7)?,
            decision_sequence: row.get(8)?,
        };
        match row.get::<_, String>(9)?.as_str() {
            "veto" => veto.push(pair),
            "skipped_reference" => skipped_references.push(pair),
            _ => recommend.push(pair),
        }
    }
    let mut hash = Sha256::new();
    hash.update(b"tagger-review-v1:0.3:0.85");
    hash.update(super::library_id_on(c)?.as_bytes());
    hash.update(serde_json::to_vec(&(
        &veto,
        &recommend,
        &skipped_references,
    ))?);
    // Also bind the inputs: equal counts/pairs after reimport, score changes below
    // thresholds, renamed mappings, reference changes and decisions on other pairs
    // must not authorize application of an older preview. These are metadata reads.
    for sql in [
        "SELECT json_array(asset_id,source,tag,score) FROM asset_tagger_character_scores ORDER BY asset_id,source,tag",
        "SELECT json_array(asset_id,source) FROM asset_tagger_coverage ORDER BY asset_id,source",
        "SELECT json_array(source,tag) FROM tagger_character_vocabulary ORDER BY source,tag",
        "SELECT json_array(target_id,tag) FROM character_target_tagger_tags ORDER BY target_id,tag",
        "SELECT json_array(target_id,asset_id,asset_hash,reason,pixai_score,canary_score) FROM character_tagger_candidates ORDER BY target_id,asset_id",
        "SELECT json_array(id,revision,display_name,series_classification_id,enabled) FROM character_targets ORDER BY id",
        "SELECT json_array(target_id,asset_id,asset_hash) FROM character_references ORDER BY target_id,slot",
        "SELECT json_array(target_id,asset_id,asset_hash,provenance) FROM character_learned_references ORDER BY target_id,asset_id",
        "SELECT json_array(id,content_hash,status,media_kind) FROM assets ORDER BY id",
        "SELECT json_array(asset_id,classification_id) FROM asset_classifications ORDER BY asset_id,classification_id",
        "SELECT json_array(id,parent_id,name) FROM classification_entries ORDER BY id",
        "SELECT json_array(series_id,asset_id) FROM character_series_asset_exclusions ORDER BY series_id,asset_id",
        "SELECT json_array(id) FROM character_excluded_folders ORDER BY id",
        "SELECT json_array(COALESCE(MAX(sequence),0)) FROM character_decisions",
    ] {
        hash.update(sql.as_bytes());
        let mut statement = c.prepare(sql)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let value: String = row.get(0)?;
            hash.update(value.as_bytes()); hash.update(b"\n");
        }
    }
    let preview = Preview {
        preview_token: hash.finalize().iter().map(|b| format!("{b:02x}")).collect(),
        veto: summary(&veto),
        skipped_references: summary(&skipped_references),
        recommend: summary(&recommend),
    };
    Ok((preview, veto, recommend))
}

impl Library {
    /// Exact Home counts without materializing assets or paging every character series.
    pub fn tagger_review_counts(&self) -> Result<TaggerReviewCounts> {
        Ok(self.connection()?.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(reason='recommendation'), 0),
                    COALESCE(SUM(reason='veto'), 0)
             FROM character_tagger_pending",
            [],
            |row| {
                Ok(TaggerReviewCounts {
                    total: row.get(0)?,
                    recommendation: row.get(1)?,
                    veto: row.get(2)?,
                })
            },
        )?)
    }

    /// Reads the complete pending tagger projection in one candidate/asset query.
    pub fn tagger_review_items(&self) -> Result<Vec<TaggerReviewItem>> {
        let connection = self.connection()?;
        let rows = connection
            .prepare(&TAGGER_REVIEW_ITEMS_SQL.replace("{CONTENT_RATING_SQL}", CONTENT_RATING_SQL))?
            .query_map([], |row| {
                Ok(PendingReviewRow {
                    asset: super::query::asset_summary_from_row(row)?,
                    series_id: row.get(22)?,
                    target_id: row.get(23)?,
                    target_name: row.get(24)?,
                    reason: row.get(25)?,
                    pixai_score: row.get(26)?,
                    canary_score: row.get(27)?,
                    scan_result: row.get(28)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        let ids = rows
            .iter()
            .map(|row| row.target_id.clone())
            .collect::<BTreeSet<_>>();
        let fingerprints =
            self.tagger_review_fingerprints(&connection, &serde_json::to_string(&ids)?)?;
        rows.into_iter()
            .map(|row| {
                let target_fingerprint = fingerprints
                    .get(&row.target_id)
                    .ok_or(Error::NotFound)?
                    .clone();
                // S36 does not persist its winning crop, so every series shows the B36
                // winner; the UI labels it B36.
                let crop = review_crop(
                    row.scan_result.as_deref(),
                    row.asset.width,
                    row.asset.height,
                );
                Ok(TaggerReviewItem {
                    crop,
                    asset: row.asset,
                    series_id: row.series_id,
                    target_id: row.target_id,
                    target_name: row.target_name,
                    target_fingerprint,
                    evidence: tagger_evidence(row.reason, row.pixai_score, row.canary_score),
                })
            })
            .collect()
    }

    /// Match the manual-decision fingerprint without loading every target and its learned
    /// references separately. Only anchor references participate in that fingerprint.
    fn tagger_review_fingerprints(
        &self,
        connection: &Connection,
        ids: &str,
    ) -> Result<BTreeMap<String, String>> {
        let mut statement = connection.prepare(TAGGER_REVIEW_FINGERPRINTS_SQL)?;
        let mut rows = statement.query([ids])?;
        let mut targets = BTreeMap::<
            String,
            (
                Option<String>,
                bool,
                bool,
                Vec<super::characters::Reference>,
            ),
        >::new();
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let target =
                targets
                    .entry(id)
                    .or_insert((row.get(1)?, row.get(2)?, row.get(3)?, Vec::new()));
            let Some(slot) = row.get::<_, Option<u32>>(4)? else {
                continue;
            };
            let asset_id: Option<String> = row.get(5)?;
            let asset_hash: String = row.get(6)?;
            let current_hash: Option<String> = row.get(7)?;
            let path: Option<String> = row.get(8)?;
            let eligible: bool = row.get(9)?;
            let status = if asset_id.is_none() {
                "missing_asset"
            } else if !eligible {
                "ineligible"
            } else if current_hash.as_deref() != Some(&asset_hash) {
                "changed_content"
            } else if path
                .as_deref()
                .is_none_or(|path| self.open_library_media(path).is_err())
            {
                "missing_file"
            } else {
                "ready"
            };
            let region = row
                .get::<_, Option<String>>(10)?
                .map(|hash| -> Result<_> {
                    Ok(super::character_reference_regions::RegionBinding {
                        content_hash: hash,
                        baseline_fingerprint: row.get(11)?,
                        bounds: serde_json::from_str(&row.get::<_, String>(12)?)?,
                    })
                })
                .transpose()?;
            target.3.push(super::characters::Reference {
                slot,
                asset_id,
                asset_hash,
                status,
                region,
            });
        }
        targets
            .into_iter()
            .map(|(id, (series, enabled, manual_only, references))| {
                let fingerprint = Sha256::digest(serde_json::to_vec(&(
                    &id,
                    series,
                    enabled,
                    manual_only,
                    references,
                ))?)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
                Ok((id, fingerprint))
            })
            .collect()
    }

    pub fn preview_tagger_review(&self) -> Result<Preview> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        Ok(preview_in(&tx)?.0)
    }

    pub fn apply_tagger_review(&self, expected_preview_token: &str) -> Result<Preview> {
        let mut c = self.connection()?;
        self.apply_tagger_review_on(&mut c, expected_preview_token)
    }

    pub(super) fn apply_tagger_review_on(
        &self,
        c: &mut Connection,
        expected_preview_token: &str,
    ) -> Result<Preview> {
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let (preview, veto, recommend) = preview_in(&tx)?;
        if preview.preview_token != expected_preview_token {
            return Err(Error::Stale);
        }
        let now = chrono::Utc::now().to_rfc3339();
        for (pairs, reason) in [(&veto, "veto"), (&recommend, "recommendation")] {
            for pair in pairs {
                if reason == "veto" {
                    // Only explicitly automatic references are disposable. Historical
                    // and editor-selected references were excluded by the preview.
                    let removed = tx.execute("DELETE FROM character_learned_references WHERE target_id=?1 AND asset_id=?2 AND provenance='automatic'", params![pair.target_id,pair.asset_id])?;
                    if removed > 0 {
                        super::character_reference_regions::prune_regions(&tx, &pair.target_id)?;
                        tx.execute("UPDATE character_targets SET revision=revision+1,updated_at=?2 WHERE id=?1", params![pair.target_id,now])?;
                    }
                    let target = self.read_character_target(&tx, &pair.target_id)?;
                    let snapshot = serde_json::json!({"source":"tagger", "reason":"veto", "previousSequence":pair.decision_sequence,
                        "pixaiScore":pair.pixai,"canaryScore":pair.canary});
                    tx.execute("INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
                        VALUES(?1,?2,?2,?3,'cleared',?4,?5,'automatic',?6)",
                        params![pair.target_id,pair.asset_id,pair.asset_hash,target.fingerprint,snapshot.to_string(),now])?;
                }
                tx.execute("INSERT INTO character_tagger_candidates VALUES(?1,?2,?3,?4,?5,?6,?7)
                    ON CONFLICT(target_id,asset_id) DO UPDATE SET asset_hash=excluded.asset_hash,reason=excluded.reason,pixai_score=excluded.pixai_score,canary_score=excluded.canary_score,created_at=excluded.created_at",
                    params![pair.target_id,pair.asset_id,pair.asset_hash,reason,pair.pixai,pair.canary,now])?;
                tx.execute(
                    "DELETE FROM character_review_completions WHERE asset_id=?1",
                    [&pair.asset_id],
                )?;
                super::character_autotag::refresh_character_review_state(&tx, &pair.asset_id)?;
            }
        }
        tx.commit()?;
        Ok(preview)
    }
}

/// Called by the ordinary review reader. Tagger evidence survives model reruns,
/// target fingerprint changes and later raw-tag imports until a human decides.
pub(super) fn pending_predictions(
    c: &Connection,
    series: &str,
    ids: &str,
) -> Result<BTreeMap<(String, String), serde_json::Value>> {
    Ok(c.prepare(
        "SELECT asset_id,target_id,reason,pixai_score,canary_score FROM character_tagger_pending
        WHERE series_id=?1 AND asset_id IN (SELECT value FROM json_each(?2))",
    )?
    .query_map(params![series, ids], |r| {
        let reason = r.get::<_, String>(2)?;
        Ok((
            (r.get(0)?, r.get(1)?),
            serde_json::json!(tagger_evidence(reason, r.get(3)?, r.get(4)?)),
        ))
    })?
    .collect::<std::result::Result<_, _>>()?)
}

#[cfg(test)]
#[path = "tagger_review_tests.rs"]
pub(super) mod tests;

#[cfg(test)]
#[path = "tagger_import_tests.rs"]
mod import_tests;

pub(super) fn preview_on(connection: &Connection) -> Result<Preview> {
    Ok(preview_in(connection)?.0)
}
