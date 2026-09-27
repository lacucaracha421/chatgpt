//! Explicit dual-tagger preview/apply. No startup hook and no inference jobs.
//! Vetoes append an automatic `cleared` decision; the existing B36 and S36
//! decision guards treat that as a durable stop, even after a later import.
//! Recommendations block automatic publication while awaiting a manual judgment.
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    characters::{Error, Result},
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
    pub fn preview_tagger_review(&self) -> Result<Preview> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        Ok(preview_in(&tx)?.0)
    }

    pub fn apply_tagger_review(&self, expected_preview_token: &str) -> Result<Preview> {
        let mut c = self.connection()?;
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
        Ok((
            (r.get(0)?, r.get(1)?),
            serde_json::json!({
                "source":"tagger", "reason":r.get::<_,String>(2)?,
                "pixaiScore":r.get::<_,f64>(3)?,"canaryScore":r.get::<_,f64>(4)?
            }),
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
