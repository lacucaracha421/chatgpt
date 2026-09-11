//! Durable incremental work. Worker execution is deliberately separate from
//! registration and review persistence; a queue item never authorizes a decision.
use super::{
    characters::{Error, Result},
    Library, LibraryError,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub(super) struct Context {
    pub hash: String,
    pub runtime: String,
    pub scope: Value,
    pub targets: Vec<super::characters::Target>,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum ReviewState {
    AwaitingCandidates,
    Unresolved,
    PartiallyResolved,
    Resolved,
    Failed,
}
impl ReviewState {
    fn stored(self) -> &'static str {
        match self {
            Self::AwaitingCandidates => "awaiting_candidates",
            Self::Unresolved => "unresolved",
            Self::PartiallyResolved => "partially_resolved",
            Self::Resolved => "resolved",
            Self::Failed => "failed",
        }
    }
}

pub(super) struct Prediction {
    pub target_id: String,
    pub result: super::character_scan::ScanResult,
}

/// One predicate for both the review error filter and its retry action. The series
/// subtree covers registered folders; the root branch covers images still filed
/// under the originals root that a failed job marked as an error.
pub(super) const FAILED_SCOPE_CTES: &str = r#"WITH RECURSIVE scope(id) AS (
    SELECT id FROM classification_entries WHERE id=?1
    UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id
), ancestors(id,parent_id) AS (
    SELECT id,parent_id FROM classification_entries WHERE id=?1
    UNION ALL SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id
)"#;

pub(super) const FAILED_SCOPE_PREDICATE: &str = r#"EXISTS(
    SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=j.asset_id AND (
        ac.classification_id IN (SELECT id FROM scope)
        OR (ac.classification_id IN (SELECT id FROM ancestors WHERE parent_id IS NULL)
            AND EXISTS(SELECT 1 FROM character_autotag_jobs failed WHERE failed.asset_id=j.asset_id AND failed.state='failed'))
    )
)"#;

pub(super) fn evidence_row(
    connection: &Connection,
    evidence_id: &str,
    target_id: &str,
) -> Result<
    Option<(
        super::character_scan::ScanStatus,
        super::character_scan::ScanResult,
    )>,
> {
    let found=connection.query_row("SELECT p.result_json,p.target_fingerprint,e.runtime_fingerprint FROM character_autotag_predictions p
        JOIN character_autotag_evidence e ON e.id=p.evidence_id
        JOIN character_autotag_jobs j ON j.asset_id=e.asset_id AND j.source_generation=e.source_generation
        JOIN assets a ON a.id=e.asset_id AND a.content_hash=e.content_hash AND a.status='normal'
        WHERE e.id=?1 AND p.target_id=?2 AND j.state<>'superseded'",params![evidence_id,target_id],|r|
            Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional()?;
    found
        .map(|(row, fingerprint, runtime)| {
            Ok((
                super::character_scan::ScanStatus {
                    automatic_queued: 0,
                    automatic: true,
                    id: evidence_id.into(),
                    target_id: target_id.into(),
                    target_fingerprint: fingerprint,
                    runtime_fingerprint: Some(runtime),
                    state: "completed".into(),
                    total: 1,
                    completed: 1,
                    errors: 0,
                    reused: 0,
                    cache_hits: 0,
                    extractions: 0,
                    error: None,
                },
                serde_json::from_str(&row)?,
            ))
        })
        .transpose()
}



pub(super) fn refresh_character_review_state(
    connection: &Connection,
    asset_id: &str,
) -> Result<()> {
    let current: Option<(String, String)> = connection
        .query_row(
            "SELECT e.id,e.content_hash FROM character_autotag_jobs j
             JOIN character_autotag_evidence e ON e.asset_id=j.asset_id
              AND e.generation=j.generation AND e.source_generation=j.source_generation
             WHERE j.asset_id=?1 AND j.state='completed'",
            [asset_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((evidence_id, content_hash)) = current else {
        return Ok(());
    };

    let predictions = connection
        .prepare(
            "SELECT target_id,series_id,result_json FROM character_autotag_predictions
             WHERE evidence_id=?1 ORDER BY target_id",
        )?
        .query_map([&evidence_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if predictions.is_empty() {
        return Ok(());
    }
    let rows = predictions
        .into_iter()
        .map(|(target_id, series_id, result)| {
            Ok((target_id, series_id, serde_json::from_str::<Value>(&result)?))
        })
        .collect::<Result<Vec<_>>>()?;
    let boxes = rows
        .first()
        .and_then(|(_, _, result)| result["evidence"]["queryBoxes"].as_array())
        .cloned()
        .unwrap_or_default();
    if boxes.is_empty() {
        return Ok(());
    }
    let series_id = &rows[0].1;
    let accepted = connection
        .prepare(
            "SELECT r.target_id FROM character_relations r
             JOIN character_targets t ON t.id=r.target_id
             WHERE r.asset_id=?1 AND t.series_classification_id=?2 ORDER BY r.target_id",
        )?
        .query_map(params![asset_id, series_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<std::collections::BTreeSet<_>, _>>()?;
    let reference_known: bool = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM character_targets t
            WHERE t.series_classification_id=?2 AND (
                EXISTS(SELECT 1 FROM character_references r WHERE r.target_id=t.id AND r.asset_id=?1 AND r.asset_hash=?3)
                OR EXISTS(SELECT 1 FROM character_learned_references r WHERE r.target_id=t.id AND r.asset_id=?1 AND r.asset_hash=?3)
            )
        )",
        params![asset_id, series_id, content_hash],
        |row| row.get(0),
    )?;

    let mut covered = Vec::new();
    for (target_id, _, result) in &rows {
        if !accepted.contains(target_id) {
            continue;
        }
        if let Some(regions) = super::character_scan::evidence_regions(result.get("evidence"), 2) {
            covered.extend(regions);
        }
    }
    let unresolved = boxes
        .iter()
        .filter(|box_value| {
            let Some(region) = box_value.as_array().and_then(|box_value| {
                if box_value.len() != 4 {
                    return None;
                }
                let region = [
                    box_value[0].as_f64()?,
                    box_value[1].as_f64()?,
                    box_value[2].as_f64()?,
                    box_value[3].as_f64()?,
                ];
                (region.iter().all(|value| value.is_finite())
                    && region[2] > region[0]
                    && region[3] > region[1])
                    .then_some(region)
            }) else {
                return true;
            };
            !covered
                .iter()
                .any(|known| super::character_scan::same_person(&region, known))
        })
        .count();
    let known = !accepted.is_empty() || reference_known;
    let state = if (known && boxes.len() == 1) || unresolved == 0 {
        "resolved"
    } else if known || !covered.is_empty() {
        "partially_resolved"
    } else {
        "unresolved"
    };
    connection.execute(
        "UPDATE character_autotag_jobs SET review_state=?2 WHERE asset_id=?1 AND state='completed'",
        params![asset_id, state],
    )?;
    Ok(())
}

pub(super) fn latest_evidence(
    connection: &Connection,
    asset_id: &str,
    target_id: &str,
) -> Result<Option<String>> {
    Ok(connection.query_row("SELECT e.id FROM character_autotag_evidence e
        JOIN character_autotag_predictions p ON p.evidence_id=e.id
        JOIN character_autotag_jobs j ON j.asset_id=e.asset_id AND j.source_generation=e.source_generation
        WHERE e.asset_id=?1 AND p.target_id=?2 AND j.state<>'superseded' ORDER BY e.generation DESC LIMIT 1",
        params![asset_id,target_id],|r|r.get(0)).optional()?)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Cause {
    Ingestion,
    Classification,
    Restore,
    SimilarityResolution,
    Reconsideration,
    ManualScanEnrollment,
    AutomaticFinalization,
}
impl Cause {
    pub(super) fn stored(self) -> &'static str {
        match self {
            Self::Ingestion => "ingestion",
            Self::Classification => "classification",
            Self::Restore => "restore",
            Self::SimilarityResolution => "similarity_resolution",
            Self::Reconsideration => "reconsideration",
            Self::ManualScanEnrollment => "manual_scan",
            Self::AutomaticFinalization => "classification",
        }
    }
    fn priority(self) -> i32 {
        match self {
            Self::ManualScanEnrollment => 0,
            Self::Ingestion | Self::Classification | Self::Restore | Self::SimilarityResolution => 1,
            Self::Reconsideration => 2,
            Self::AutomaticFinalization => 1,
        }
    }
    fn force(self) -> bool {
        matches!(self, Self::Reconsideration | Self::ManualScanEnrollment)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub asset_id: String,
    pub generation: i64,
    pub source_generation: i64,
    pub content_hash: String,
    pub relative_path: String,
    pub classification_ids: Vec<String>,
    pub state: String,
    pub review_state: String,
    pub claim_id: Option<String>,
    pub attempts: i64,
    pub cause: String,
    pub error: Option<String>,
}

fn folders(connection: &Connection, asset_id: &str) -> rusqlite::Result<Vec<String>> {
    connection.prepare("SELECT classification_id FROM asset_classifications WHERE asset_id=?1 ORDER BY classification_id")?
        .query_map([asset_id], |r| r.get(0))?.collect()
}

fn in_originals_scope(connection: &Connection, asset_id: &str) -> rusqlite::Result<bool> {
    connection.query_row("WITH RECURSIVE lineage(id,parent_id) AS (
        SELECT c.id,c.parent_id FROM classification_entries c JOIN asset_classifications a ON a.classification_id=c.id WHERE a.asset_id=?1
        UNION ALL SELECT c.id,c.parent_id FROM classification_entries c JOIN lineage p ON c.id=p.parent_id)
        SELECT EXISTS(SELECT 1 FROM lineage l JOIN classification_roles r ON r.classification_id=l.id WHERE r.role='originals')",
        [asset_id], |r| r.get(0))
}

/// Call after the final classification/status mutation, inside its transaction.
/// Equal inputs are a no-op; reconsideration intentionally creates a fresh attempt.
pub(super) fn enqueue(
    connection: &Connection,
    asset_id: &str,
    cause: Cause,
) -> std::result::Result<bool, LibraryError> {
    if cause == Cause::AutomaticFinalization {
        return Ok(false);
    }
    let input: Option<(String, String)> = connection.query_row(
        "SELECT content_hash,relative_path FROM assets WHERE id=?1 AND status='normal' AND media_kind='image'",
        [asset_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((hash, path)) = input else {
        return Ok(false);
    };
    if in_originals_scope(connection, asset_id)? {
        connection.execute("UPDATE character_autotag_jobs SET state='superseded',claim_id=NULL,error=NULL,updated_at=?2 WHERE asset_id=?1 AND state<>'superseded'",
            params![asset_id,chrono::Utc::now().to_rfc3339()])?;
        return Ok(false);
    }
    let classification =
        serde_json::to_string(&folders(connection, asset_id)?).expect("string list");
    if cause == Cause::ManualScanEnrollment {
        let existing: Option<(String, String, String, String)> = connection
            .query_row(
                "SELECT state,content_hash,relative_path,classification_ids FROM character_autotag_jobs WHERE asset_id=?1",
                [asset_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((state, existing_hash, existing_path, existing_classification)) = existing {
            if existing_hash == hash
                && existing_path == path
                && existing_classification == classification
            {
                if state == "processing" {
                    return Ok(false);
                }
                if state == "pending" {
                    let changed = connection.execute(
                        "UPDATE character_autotag_jobs
                         SET priority=?2,cause=?3,retry_at=0,error=NULL,updated_at=?4
                         WHERE asset_id=?1 AND state='pending'
                           AND (priority<>?2 OR cause<>?3 OR retry_at<>0 OR error IS NOT NULL)",
                        params![asset_id,cause.priority(),cause.stored(),chrono::Utc::now().to_rfc3339()],
                    )?;
                    return Ok(changed > 0);
                }
            }
        }
    }
    let force = cause.force();
    let changed = connection.execute("INSERT INTO character_autotag_jobs
        (asset_id,generation,content_hash,relative_path,classification_ids,state,review_state,priority,cause,updated_at)
        VALUES(?1,1,?2,?3,?4,'pending','unresolved',?5,?6,?7)
        ON CONFLICT(asset_id) DO UPDATE SET generation=generation+1,source_generation=source_generation+CASE WHEN ?8 AND character_autotag_jobs.state<>'superseded' AND content_hash=excluded.content_hash AND relative_path=excluded.relative_path AND classification_ids=excluded.classification_ids THEN 0 ELSE 1 END,content_hash=excluded.content_hash,
        relative_path=excluded.relative_path,classification_ids=excluded.classification_ids,
        state='pending',review_state='unresolved',claim_id=NULL,priority=excluded.priority,cause=excluded.cause,
        attempts=0,retry_at=0,error=NULL,updated_at=excluded.updated_at
        WHERE ?8 OR character_autotag_jobs.state='superseded'
        OR content_hash<>excluded.content_hash OR relative_path<>excluded.relative_path
        OR classification_ids<>excluded.classification_ids",
        params![asset_id,hash,path,classification,cause.priority(),cause.stored(),chrono::Utc::now().to_rfc3339(),force])?;
    Ok(changed > 0)
}

fn read_job(connection: &Connection, id: &str) -> Result<Option<Job>> {
    let data = connection.query_row("SELECT asset_id,generation,content_hash,relative_path,classification_ids,
        state,review_state,claim_id,attempts,error,source_generation,cause FROM character_autotag_jobs WHERE asset_id=?1", [id], |r| {
        Ok((Job { asset_id:r.get(0)?,generation:r.get(1)?,source_generation:r.get(10)?,content_hash:r.get(2)?,relative_path:r.get(3)?,
            classification_ids:Vec::new(),state:r.get(5)?,review_state:r.get(6)?,claim_id:r.get(7)?,attempts:r.get(8)?,cause:r.get(11)?,error:r.get(9)? },r.get::<_,String>(4)?))
    }).optional()?;
    data.map(|(mut job, classification)| {
        job.classification_ids = serde_json::from_str(&classification)?;
        Ok(job)
    })
    .transpose()
}

impl Library {
    /// Explicit manual analysis enrolls historical images in the same durable
    /// pipeline as new arrivals. The queue rechecks all competing characters;
    /// no prediction or user decision is directly applied here.
    pub(super) fn queue_analyzed_character_assets(
        &self,
        target: &super::characters::Target,
        asset_ids: &[String],
        runtime_fingerprint: &str,
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<usize> {
        use std::sync::atomic::Ordering;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let current = self.read_character_target(&transaction, &target.id)?;
        if current.fingerprint != target.fingerprint {
            return Err(Error::Stale);
        }
        let Some(series) = current.series_classification_id.as_deref() else {
            return Err(Error::Stale);
        };
        let enabled: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1 AND auto_classify=1)",
            [series], |r| r.get(0))?;
        if !enabled {
            return Ok(0);
        }
        let learned_references = serde_json::to_value(current.usable_learned_references().collect::<Vec<_>>())?;
        let mut queued = 0;
        for id in asset_ids {
            if cancel.load(Ordering::Acquire) {
                return Ok(0);
            }
            // Ignore images moved out of this series, trashed, or made unavailable
            // since the manual scan. Enrollment always snapshots current inputs.
            if super::character_hub::candidate_image_mode(&transaction, series, id, false).is_err()
            {
                continue;
            }
            let in_flight: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM character_autotag_jobs WHERE asset_id=?1 AND state IN ('pending','processing'))",
                [id], |r| r.get(0))?;
            if in_flight {
                queued += usize::from(enqueue(&transaction, id, Cause::ManualScanEnrollment)?);
                continue;
            }
            let current_prediction = latest_evidence(&transaction, id, &current.id)?
                .map(|evidence_id| evidence_row(&transaction, &evidence_id, &current.id))
                .transpose()?
                .flatten()
                .is_some_and(|(status, result)| {
                    status.target_fingerprint == current.fingerprint
                        && status.runtime_fingerprint.as_deref() == Some(runtime_fingerprint)
                        && result.evidence.as_ref().is_some_and(|evidence| {
                            evidence.get("learnedReferences") == Some(&learned_references)
                        })
                });
            if current_prediction {
                continue;
            }
            queued += usize::from(enqueue(&transaction, id, Cause::ManualScanEnrollment)?);
        }
        if cancel.load(Ordering::Acquire) {
            return Ok(0);
        }
        transaction.commit()?;
        Ok(queued)
    }

    /// Retries exactly what the review error filter lists: series-scope assets plus
    /// root-category assets whose job failed. A narrower scope would leave visible
    /// failures without a reachable retry route.
    pub fn retry_failed_character_assets(&self, series_id: String) -> Result<usize> {
        let mut connection = self.connection()?;
        let tx = connection.transaction()?;
        let ids = tx.prepare(&format!(
            "{FAILED_SCOPE_CTES}
             SELECT j.asset_id FROM character_autotag_jobs j
             JOIN assets a ON a.id=j.asset_id AND a.status='normal' AND a.media_kind='image'
             WHERE j.state='failed' AND {FAILED_SCOPE_PREDICATE}
             ORDER BY j.asset_id LIMIT 200"
        ))?
            .query_map([&series_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for id in &ids {
            enqueue(&tx, id, Cause::Reconsideration)?;
        }
        tx.commit()?;
        Ok(ids.len())
    }

    /// Durable, metadata-only failure count for the same predicate retry acts on.
    /// The review panel polls this so failures survive a restart instead of living
    /// only in the in-memory scan status.
    pub fn failed_character_asset_count(&self, series_id: &str) -> Result<usize> {
        let connection = self.connection()?;
        let count: i64 = connection.query_row(
            &format!(
                "{FAILED_SCOPE_CTES}
                 SELECT COUNT(*) FROM character_autotag_jobs j
                 JOIN assets a ON a.id=j.asset_id AND a.status='normal' AND a.media_kind='image'
                 WHERE j.state='failed' AND {FAILED_SCOPE_PREDICATE}"
            ),
            [series_id],
            |r| r.get(0),
        )?;
        Ok(count as usize)
    }

    pub fn character_autotag_job(&self, asset_id: &str) -> Result<Option<Job>> {
        let connection = self.connection()?;
        read_job(&connection, asset_id)
    }

    pub(super) fn recover_character_autotag(&self) -> std::result::Result<(), LibraryError> {
        self.connection()?.execute(
            "UPDATE character_autotag_jobs SET state='pending',claim_id=NULL
            WHERE state='processing'",
            [],
        )?;
        Ok(())
    }

    /// Called by the native owner only. Fresh ingestion precedes reconsideration.
    pub(super) fn claim_character_autotag(&self) -> Result<Option<Job>> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let id: Option<String> = transaction
            .query_row(
                "SELECT asset_id FROM character_autotag_jobs
            WHERE state='pending' AND retry_at<=?1 ORDER BY priority,updated_at,asset_id LIMIT 1",
                [chrono::Utc::now().timestamp()],
                |r| r.get(0),
            )
            .optional()?;
        let Some(id) = id else {
            return Ok(None);
        };
        transaction.execute("UPDATE character_autotag_jobs SET state='processing',claim_id=?2,attempts=attempts+1 WHERE asset_id=?1",
            params![id,uuid::Uuid::new_v4().to_string()])?;
        let result = read_job(&transaction, &id)?;
        transaction.commit()?;
        Ok(result)
    }

    /// A claim token fences late replies after recovery even at the same generation.
    pub(super) fn check_character_autotag_claim(connection: &Connection, job: &Job) -> Result<()> {
        let current = read_job(connection, &job.asset_id)?.ok_or(Error::Stale)?;
        if current.generation != job.generation
            || current.state != "processing"
            || current.claim_id.is_none()
            || current.claim_id != job.claim_id
        {
            return Err(Error::Stale);
        }
        let matches: bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM assets
            WHERE id=?1 AND status='normal' AND media_kind='image' AND content_hash=?2 AND relative_path=?3)",
            params![job.asset_id,job.content_hash,job.relative_path],|r|r.get(0))?;
        if !matches || folders(connection, &job.asset_id)? != job.classification_ids {
            return Err(Error::Stale);
        }
        Ok(())
    }

    pub(super) fn character_autotag_context(
        &self,
        connection: &Connection,
        job: &Job,
        runtime: &str,
    ) -> Result<Context> {
        Self::check_character_autotag_claim(connection, job)?;
        // A registered descendant series owns its own scope, even when another
        // registered series is an ancestor (including a disabled ancestor).
        let nearest_series: Option<String>=connection.query_row("WITH RECURSIVE lineage(id,parent_id,depth) AS (
            SELECT c.id,c.parent_id,0 FROM classification_entries c JOIN asset_classifications a ON a.classification_id=c.id WHERE a.asset_id=?1
            UNION ALL SELECT c.id,c.parent_id,p.depth+1 FROM classification_entries c JOIN lineage p ON c.id=p.parent_id)
            SELECT l.id FROM lineage l JOIN character_series s ON s.classification_id=l.id ORDER BY l.depth,l.id LIMIT 1",
            [&job.asset_id],|r|r.get(0)).optional()?;
        let originals = in_originals_scope(connection, &job.asset_id)?;
        let excluded = if let Some(series) = nearest_series.as_ref() {
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM character_series_asset_exclusions WHERE series_id=?1 AND asset_id=?2)",
                params![series,job.asset_id], |r| r.get(0))?
        } else { false };
        let ids = if originals || excluded {
            Vec::new()
        } else {
            connection.prepare("SELECT t.id FROM character_targets t JOIN character_series s ON s.classification_id=t.series_classification_id
                WHERE s.auto_classify=1 AND t.enabled=1 AND t.manual_only=0 AND (?1 IS NULL OR s.classification_id=?1) ORDER BY t.id")?
                .query_map([nearest_series],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?
        };
        let mut targets = Vec::new();
        let mut invalid_reference_targets = Vec::new();
        for id in ids {
            let target = self.read_character_target(connection, &id)?;
            if target.has_invalid_learned_references() {
                invalid_reference_targets.push(target.id.clone());
                continue;
            }
            if job.classification_ids.len() == 1
                && target.ready
                && target
                    .series_classification_id
                    .as_ref()
                    .is_some_and(|series| {
                        super::character_hub::candidate_image_mode(
                            connection,
                            series,
                            &job.asset_id,
                            true,
                        )
                        .is_ok()
                    })
            {
                targets.push(target);
            }
        }
        // A broken explicit reference is a series configuration problem. Do not
        // silently remove that competitor and let the remaining targets auto-accept.
        if !invalid_reference_targets.is_empty() {
            targets.clear();
        }
        let lineage=connection.prepare("WITH RECURSIVE ancestors(id,parent_id) AS (
            SELECT c.id,c.parent_id FROM classification_entries c JOIN asset_classifications a ON a.classification_id=c.id WHERE a.asset_id=?1
            UNION SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id)
            SELECT a.id,a.parent_id,s.auto_classify FROM ancestors a LEFT JOIN character_series s ON s.classification_id=a.id ORDER BY a.id")?
            .query_map([&job.asset_id],|r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<bool>>(2)?)))?
            .collect::<std::result::Result<Vec<_>,_>>()?;
        let mut series_lineage = Vec::new();
        for series in targets
            .iter()
            .filter_map(|t| t.series_classification_id.as_ref())
            .collect::<std::collections::BTreeSet<_>>()
        {
            let rows=connection.prepare("WITH RECURSIVE ancestors(id,parent_id) AS (
                SELECT id,parent_id FROM classification_entries WHERE id=?1 UNION SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id)
                SELECT id,parent_id FROM ancestors ORDER BY id")?
                .query_map([series],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))?
                .collect::<std::result::Result<Vec<_>,_>>()?;
            series_lineage.push((series.clone(), rows));
        }
        let scope = json!({"classificationIds":job.classification_ids,"lineage":lineage,"seriesLineage":series_lineage,"invalidReferenceTargetIds":invalid_reference_targets});
        let recognition=targets.iter().map(|t|json!({"id":t.id,"fingerprint":t.fingerprint,"learnedReferences":t.usable_learned_references().collect::<Vec<_>>()})).collect::<Vec<_>>();
        let encoded = serde_json::to_vec(
            &json!({"assetId":job.asset_id,"hash":job.content_hash,"path":job.relative_path,
            "scope":scope,"candidates":recognition,"runtime":runtime}),
        )?;
        Ok(Context {
            hash: Sha256::digest(encoded)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            runtime: runtime.into(),
            scope,
            targets,
        })
    }

    /// Machine evidence publication only; automatic relations additionally require
    /// source-byte validation and arbitration in the caller's final transaction.
    pub(super) fn publish_character_autotag(
        &self,
        connection: &rusqlite::Transaction<'_>,
        job: &Job,
        context: &Context,
        predictions: &[Prediction],
        review: ReviewState,
        unresolved_regions: &Value,
    ) -> Result<String> {
        let current = self.character_autotag_context(connection, job, &context.runtime)?;
        if current.hash != context.hash {
            return Err(Error::Stale);
        }
        let expected = context
            .targets
            .iter()
            .map(|t| t.id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let actual = predictions
            .iter()
            .map(|p| p.target_id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        if expected != actual
            || actual.len() != predictions.len()
            || !unresolved_regions.is_array()
            || matches!(review, ReviewState::AwaitingCandidates) != context.targets.is_empty()
        {
            return Err(Error::Invalid("분석 결과 묶음이 불완전합니다."));
        }
        for prediction in predictions {
            let row = &prediction.result;
            if row.asset_id != job.asset_id
                || row.content_hash != job.content_hash
                || row.evidence.as_ref().is_some_and(|e| !e.is_object())
                || (matches!(row.state.as_str(), "recommended" | "unmatched")
                    && row.evidence.is_none())
                || !matches!(
                    row.state.as_str(),
                    "recommended" | "unmatched" | "ambiguous" | "error" | "stale"
                )
            {
                return Err(Error::Invalid("분석 결과 식별자가 올바르지 않습니다."));
            }
        }
        let id = format!("autotag:{}", uuid::Uuid::new_v4());
        connection.execute("INSERT INTO character_autotag_evidence(id,asset_id,generation,content_hash,context_hash,runtime_fingerprint,scope_json,unresolved_regions,created_at,source_generation)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", params![id,job.asset_id,job.generation,job.content_hash,context.hash,context.runtime,
            serde_json::to_string(&context.scope)?,serde_json::to_string(unresolved_regions)?,chrono::Utc::now().to_rfc3339(),job.source_generation])?;
        for prediction in predictions {
            let target = context
                .targets
                .iter()
                .find(|t| t.id == prediction.target_id)
                .ok_or(Error::Stale)?;
            let mut row = prediction.result.clone();
            if let Some(evidence) = row.evidence.as_mut() {
                evidence["learnedReferences"] = json!(target.usable_learned_references().collect::<Vec<_>>());
                evidence["runtimeFingerprint"] = json!(context.runtime);
                evidence["automaticScope"] = json!(true);
            }
            connection.execute("INSERT INTO character_autotag_predictions(evidence_id,target_id,series_id,target_fingerprint,result_json) VALUES(?1,?2,?3,?4,?5)",
                params![id,target.id,target.series_classification_id,target.fingerprint,serde_json::to_string(&row)?])?;
        }
        connection.execute("UPDATE character_autotag_jobs SET state='completed',review_state=?2,claim_id=NULL,error=NULL WHERE asset_id=?1",
            params![job.asset_id,review.stored()])?;
        Ok(id)
    }

    /// Bounded selection by asset disposition, never by losing target predictions.
    /// Includes checkpoints created before a series/target was registered.
    pub(super) fn reconsider_character_autotag(
        &self,
        series_id: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<String>> {
        if !(1..=200).contains(&limit) {
            return Err(Error::Invalid("재검토 묶음 크기가 올바르지 않습니다."));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let ids=transaction.prepare("WITH RECURSIVE descendants(id) AS (
            SELECT id FROM classification_entries WHERE id=?1 UNION SELECT c.id FROM classification_entries c JOIN descendants s ON c.parent_id=s.id),
            ancestors(id,parent_id) AS (SELECT id,parent_id FROM classification_entries WHERE id=?1
            UNION SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id)
            SELECT j.asset_id FROM character_autotag_jobs j JOIN assets a ON a.id=j.asset_id
            WHERE j.review_state IN ('awaiting_candidates','unresolved','partially_resolved','failed')
            AND j.state IN ('completed','failed') AND a.status='normal' AND (?2 IS NULL OR j.asset_id>?2)
            AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=j.asset_id
            AND (ac.classification_id IN (SELECT id FROM descendants) OR ac.classification_id IN (SELECT id FROM ancestors WHERE parent_id IS NULL)))
            ORDER BY j.asset_id LIMIT ?3")?
            .query_map(params![series_id,after,limit as i64], |r|r.get::<_,String>(0))?
            .collect::<std::result::Result<Vec<_>,_>>()?;
        for id in &ids {
            enqueue(&transaction, id, Cause::Reconsideration)?;
        }
        transaction.commit()?;
        Ok(ids)
    }
}

#[cfg(test)]
#[path = "character_autotag_tests.rs"]
mod tests;
