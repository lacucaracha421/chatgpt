use super::{
    character_autotag::Job,
    character_reference_candidates::reference_set_hash,
    characters::{Error, Result},
    Library,
};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceRefreshState {
    Pending,
    Running,
    Failed,
    Completed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceRefreshReceipt {
    pub target_id: String,
    pub request_revision: i64,
    pub state: ReferenceRefreshState,
    pub eligible_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceRefreshProgress {
    target_id: String,
    target_name: String,
    series_name: String,
    state: String,
    total: Option<usize>,
    processed: usize,
    remaining: usize,
    failed: usize,
}

pub(super) fn refresh_progress(c: &rusqlite::Connection) -> Result<Vec<ReferenceRefreshProgress>> {
    Ok(c.prepare("SELECT r.target_id,t.display_name,s.name,r.state,r.eligible_count,r.discovery_complete,
            SUM(CASE WHEN i.state IN ('pending','processing') THEN 1 ELSE 0 END),r.failure_count,r.visited_count
        FROM character_reference_refreshes r JOIN character_targets t ON t.id=r.target_id
        JOIN classification_entries s ON s.id=r.series_classification_id
        LEFT JOIN character_reference_refresh_items i ON i.target_id=r.target_id AND i.request_revision=r.request_revision
        WHERE r.state IN ('pending','running','failed')
        GROUP BY r.target_id ORDER BY r.requested_at,r.target_id")?.query_map([], |row| {
            let total = row.get::<_, i64>(4)?.max(0) as usize;
            let complete: bool = row.get(5)?;
            let remaining = row.get::<_, i64>(6)?.max(0) as usize;
            Ok(ReferenceRefreshProgress {
                target_id: row.get(0)?, target_name: row.get(1)?, series_name: row.get(2)?, state: row.get(3)?,
                total: complete.then_some(total),
                processed: if complete { total.saturating_sub(remaining) } else { row.get::<_,i64>(8)?.max(0) as usize },
                remaining, failed: row.get::<_,i64>(7)?.max(0) as usize,
            })
        })?.collect::<std::result::Result<Vec<_>,_>>()?)
}

pub(super) enum ReferenceRefreshEvidenceReuse {
    Exact(Value),
    Delta(Value),
}

// Explicit history belongs to the requested series subtree. Fresh ingestion may
// infer descendant series from an ordinary parent, but must not widen a refresh.
const REFRESH_SCOPE: &str = r#"WITH RECURSIVE subtree(id) AS (
    SELECT id FROM classification_entries WHERE id=?2
    UNION ALL SELECT c.id FROM classification_entries c JOIN subtree s ON c.parent_id=s.id
    WHERE NOT EXISTS(SELECT 1 FROM character_series cs WHERE cs.classification_id=c.id)
)"#;

// The same eligibility check is used at snapshot, feed and claim time. Existing
// manual decisions and reference images must never become automatic refresh input.
const REFRESH_ELIGIBLE: &str = r#"a.status='normal' AND a.media_kind='image'
    AND COALESCE(j.review_state,'unresolved')<>'resolved'
    AND NOT EXISTS(SELECT 1 FROM asset_classifications ac JOIN character_excluded_folders e ON e.id=ac.classification_id WHERE ac.asset_id=a.id)
    AND NOT EXISTS(SELECT 1 FROM character_series_asset_exclusions e WHERE e.series_id=?2 AND e.asset_id=a.id)
    AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.asset_id=a.id)
    AND NOT EXISTS(SELECT 1 FROM character_learned_references r WHERE r.asset_id=a.id)
    AND NOT EXISTS(SELECT 1 FROM character_relations r WHERE r.target_id=?1 AND r.asset_id=a.id)
    AND COALESCE((SELECT origin FROM character_decisions
        WHERE target_id=?1 AND source_asset_id=a.id ORDER BY sequence DESC LIMIT 1),'')<>'manual'"#;

fn refresh_eligible(c: &rusqlite::Connection, target: &str, series: &str, asset: &str) -> Result<bool> {
    let scope = super::character_scope::resolve_character_scope(c, asset)?;
    if !scope.is_some_and(|scope| scope.series_classification_ids.iter().any(|id| id == series)) {
        return Ok(false);
    }
    Ok(c.query_row(&format!("{REFRESH_SCOPE} SELECT EXISTS(SELECT 1 FROM assets a
        LEFT JOIN character_autotag_jobs j ON j.asset_id=a.id WHERE a.id=?3
        AND EXISTS(SELECT 1 FROM asset_classifications ac JOIN subtree s ON s.id=ac.classification_id WHERE ac.asset_id=a.id)
        AND {REFRESH_ELIGIBLE})"),
        params![target,series,asset], |r| r.get(0))?)
}

impl Library {
    pub fn set_character_reference_refresh_paused(&self, paused: bool) -> Result<()> {
        self.connection()?.execute(
            "UPDATE character_autotag_control SET reference_refresh_paused=?1 WHERE singleton=1",
            [paused],
        )?;
        Ok(())
    }

    pub fn request_character_reference_refresh(
        &self,
        target_id: &str,
        expected_revision: i64,
    ) -> Result<ReferenceRefreshReceipt> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let target = self.read_character_target(&transaction, target_id)?;
        if target.revision != expected_revision {
            return Err(Error::Stale);
        }
        if !target.ready || target.manual_only {
            return Err(Error::Invalid("레퍼런스 설정을 먼저 확인해 주세요."));
        }
        let series_id = target
            .series_classification_id
            .clone()
            .ok_or(Error::Stale)?;
        let requested_hash = reference_set_hash(&target)?;
        let requested_hashes = target
            .usable_references()
            .map(|reference| reference.asset_hash.clone())
            .collect::<Vec<_>>();
        let existing: Option<(i64, String, String, String, i64)> = transaction.query_row(
            "SELECT request_revision,requested_reference_set_hash,requested_reference_hashes_json,state,eligible_count
             FROM character_reference_refreshes WHERE target_id=?1",
            [target_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).optional()?;
        if let Some((revision, hash, _, state, eligible)) = &existing {
            if hash == &requested_hash && matches!(state.as_str(), "pending" | "running") {
                transaction.commit()?;
                return Ok(ReferenceRefreshReceipt {
                    target_id: target_id.into(),
                    request_revision: *revision,
                    state: if state == "running" {
                        ReferenceRefreshState::Running
                    } else {
                        ReferenceRefreshState::Pending
                    },
                    eligible_count: (*eligible).max(0) as usize,
                });
            }
        }
        let request_revision = existing.as_ref().map_or(1, |row| row.0 + 1);
        let previous_hash = existing.as_ref().map(|row| row.1.clone());
        let previous_hashes = existing
            .as_ref()
            .and_then(|row| serde_json::from_str::<Vec<String>>(&row.2).ok())
            .unwrap_or_default();
        let added_hashes = if !previous_hashes.is_empty()
            && requested_hashes.len() > previous_hashes.len()
            && requested_hashes.starts_with(&previous_hashes)
        {
            requested_hashes[previous_hashes.len()..].to_vec()
        } else {
            Vec::new()
        };

        let now = chrono::Utc::now().timestamp();
        transaction.execute(
            "UPDATE character_reference_refresh_items SET state='superseded',updated_at=?2
             WHERE target_id=?1 AND state IN ('pending','processing')",
            params![target_id, now],
        )?;
        transaction.execute(
            "INSERT INTO character_reference_refreshes(target_id,series_classification_id,target_revision,request_revision,
                previous_reference_set_hash,requested_reference_set_hash,requested_reference_hashes_json,added_reference_hashes_json,
                after_asset_id,state,eligible_count,visited_count,delta_count,fallback_count,published_count,failure_count,last_error,
                requested_at,started_at,completed_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,NULL,'pending',0,0,0,0,0,0,NULL,?9,NULL,NULL,?9)
             ON CONFLICT(target_id) DO UPDATE SET series_classification_id=excluded.series_classification_id,
                target_revision=excluded.target_revision,request_revision=excluded.request_revision,
                previous_reference_set_hash=excluded.previous_reference_set_hash,requested_reference_set_hash=excluded.requested_reference_set_hash,
                requested_reference_hashes_json=excluded.requested_reference_hashes_json,added_reference_hashes_json=excluded.added_reference_hashes_json,
                after_asset_id=NULL,state='pending',eligible_count=0,visited_count=0,delta_count=0,fallback_count=0,published_count=0,
                failure_count=0,last_error=NULL,requested_at=excluded.requested_at,started_at=NULL,completed_at=NULL,updated_at=excluded.updated_at",
            params![target_id, series_id, target.revision, request_revision, previous_hash, requested_hash,
                serde_json::to_string(&requested_hashes)?, serde_json::to_string(&added_hashes)?, now],
        )?;
        // Persist only candidate IDs and evidence pointers, never all jobs or media.
        // A single metadata snapshot includes images that predate the automatic queue
        // and gives this request a stable boundary across restart, deletion and VACUUM.
        let eligible_count = transaction.execute(&format!(r#"
            {REFRESH_SCOPE}, originals(id) AS (
                SELECT classification_id FROM classification_roles WHERE role='originals'
                UNION ALL SELECT c.id FROM classification_entries c JOIN originals o ON c.parent_id=o.id
            )
            INSERT INTO character_reference_refresh_items(target_id,request_revision,asset_id,base_evidence_id,generation,state,updated_at)
            SELECT ?1,?3,a.id,COALESCE(
                (SELECT e.id FROM character_autotag_evidence e
                 WHERE e.asset_id=a.id AND e.generation=j.generation AND e.source_generation=j.source_generation AND e.content_hash=a.content_hash
                 ORDER BY e.created_at DESC,e.id DESC LIMIT 1),
                (SELECT i.base_evidence_id FROM character_reference_refresh_items i
                 WHERE i.target_id=?1 AND i.asset_id=a.id AND i.base_evidence_id IS NOT NULL
                 ORDER BY i.request_revision DESC LIMIT 1)
            ),COALESCE(j.generation,0)+1,'pending',?4
            FROM subtree s JOIN asset_classifications ac ON ac.classification_id=s.id
            JOIN assets a ON a.id=ac.asset_id LEFT JOIN character_autotag_jobs j ON j.asset_id=a.id
            WHERE EXISTS(SELECT 1 FROM character_series WHERE classification_id=?2 AND auto_classify=1)
              AND ?2 NOT IN (SELECT id FROM originals) AND s.id NOT IN (SELECT id FROM originals)
              AND ?2 NOT IN (SELECT id FROM character_excluded_folders)
              AND NOT EXISTS(SELECT 1 FROM asset_classifications other WHERE other.asset_id=a.id AND other.classification_id<>ac.classification_id)
              AND (j.review_state='partially_resolved' OR NOT EXISTS(
                  SELECT 1 FROM character_relations r JOIN character_targets t ON t.id=r.target_id
                  WHERE r.asset_id=a.id AND t.series_classification_id=?2))
              AND {REFRESH_ELIGIBLE}
        "#), params![target_id,series_id,request_revision,now])?;
        transaction.execute("UPDATE character_reference_refreshes SET discovery_complete=1,eligible_count=?3,
            state=CASE WHEN ?3=0 THEN 'completed' ELSE 'pending' END,completed_at=CASE WHEN ?3=0 THEN ?4 ELSE NULL END
            WHERE target_id=?1 AND request_revision=?2", params![target_id,request_revision,eligible_count as i64,now])?;
        transaction.commit()?;
        Ok(ReferenceRefreshReceipt {
            target_id: target_id.into(),
            request_revision,
            state: if eligible_count == 0 { ReferenceRefreshState::Completed } else { ReferenceRefreshState::Pending },
            eligible_count,
        })
    }

    pub(super) fn advance_character_reference_refresh(&self, batch_size: usize) -> Result<usize> {
        if !(1..=200).contains(&batch_size) {
            return Err(Error::Invalid(
                "과거 이미지 갱신 묶음 크기가 올바르지 않습니다.",
            ));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let paused: bool = transaction.query_row(
            "SELECT reference_refresh_paused FROM character_autotag_control WHERE singleton=1",
            [],
            |row| row.get(0),
        )?;
        if paused {
            return Ok(0);
        }
        let refresh: Option<(String, i64, String, i64, String, Option<String>, bool, i64)> = transaction.query_row(
            "SELECT target_id,request_revision,series_classification_id,target_revision,requested_reference_set_hash,
                    after_asset_id,discovery_complete,through_job_sequence
             FROM character_reference_refreshes WHERE state IN ('pending','running')
             ORDER BY requested_at,target_id LIMIT 1",
            [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?)),
        ).optional()?;
        let Some((
            target_id,
            request_revision,
            series_id,
            target_revision,
            requested_hash,
            mut after_asset_id,
            mut discovery_complete,
            through_job_sequence,
        )) = refresh
        else {
            return Ok(0);
        };
        let target = self.read_character_target(&transaction, &target_id)?;
        if target.revision != target_revision || reference_set_hash(&target)? != requested_hash {
            let now = chrono::Utc::now().timestamp();
            transaction.execute(
                "UPDATE character_reference_refresh_items SET state='superseded',updated_at=?3
                 WHERE target_id=?1 AND request_revision=?2 AND state='pending'",
                params![target_id, request_revision, now],
            )?;
            transaction.execute(
                "UPDATE character_reference_refreshes SET state='failed',last_error='레퍼런스가 변경되었습니다.',updated_at=?3
                 WHERE target_id=?1 AND request_revision=?2",
                params![target_id,request_revision,now],
            )?;
            transaction.commit()?;
            return Ok(0);
        }
        let mut items = transaction
            .prepare(
                "SELECT asset_id,generation FROM character_reference_refresh_items
             WHERE target_id=?1 AND request_revision=?2 AND state='pending'
             ORDER BY asset_id LIMIT ?3",
            )?
            .query_map(
                params![target_id, request_revision, batch_size as i64],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if items.is_empty() && !discovery_complete {
            let candidates = transaction
                .prepare(
                    "SELECT j.asset_id,j.generation,
                        COALESCE(
                            (SELECT e.id FROM character_autotag_evidence e
                             WHERE e.asset_id=j.asset_id AND e.generation=j.generation
                               AND e.source_generation=j.source_generation AND e.content_hash=a.content_hash
                             ORDER BY e.created_at DESC,e.id DESC LIMIT 1),
                            (SELECT i.base_evidence_id FROM character_reference_refresh_items i
                             WHERE i.target_id=?1 AND i.asset_id=j.asset_id AND i.base_evidence_id IS NOT NULL
                             ORDER BY i.request_revision DESC LIMIT 1)
                        )
                     FROM character_autotag_jobs j JOIN assets a ON a.id=j.asset_id
                     JOIN character_autotag_admissions admission ON admission.asset_id=j.asset_id
                     WHERE (j.review_state IN ('awaiting_candidates','unresolved','partially_resolved','failed')
                            OR (j.review_state='superseded' AND EXISTS(
                                SELECT 1 FROM character_reference_refresh_items prior
                                WHERE prior.target_id=?1 AND prior.asset_id=j.asset_id
                                  AND prior.state='superseded'
                            )))
                       AND a.status='normal' AND a.media_kind='image'
                       AND (?2 IS NULL OR j.asset_id>?2)
                       AND admission.sequence<=?4
                     ORDER BY j.asset_id LIMIT ?3",
                )?
                .query_map(
                    params![target_id, after_asset_id, batch_size as i64, through_job_sequence],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            if candidates.is_empty() {
                discovery_complete = true;
                transaction.execute(
                    "UPDATE character_reference_refreshes SET discovery_complete=1,updated_at=?3
                     WHERE target_id=?1 AND request_revision=?2",
                    params![target_id, request_revision, chrono::Utc::now().timestamp()],
                )?;
            } else {
                let now = chrono::Utc::now().timestamp();
                if candidates.len() < batch_size {
                    discovery_complete = true;
                }
                let mut discovered = 0i64;
                for (asset_id, generation, evidence_id) in candidates {
                    after_asset_id = Some(asset_id.clone());
                    if !refresh_eligible(&transaction, &target_id, &series_id, &asset_id)? {
                        continue;
                    }
                    transaction.execute(
                        "INSERT INTO character_reference_refresh_items(target_id,request_revision,asset_id,base_evidence_id,generation,state,updated_at)
                         VALUES(?1,?2,?3,?4,?5,'pending',?6)",
                        params![target_id, request_revision, asset_id, evidence_id, generation + 1, now],
                    )?;
                    items.push((asset_id, generation + 1));
                    discovered += 1;
                }
                transaction.execute(
                    "UPDATE character_reference_refreshes SET after_asset_id=?3,eligible_count=eligible_count+?4,
                        discovery_complete=?5,updated_at=?6
                     WHERE target_id=?1 AND request_revision=?2",
                    params![target_id, request_revision, after_asset_id, discovered, i64::from(discovery_complete), now],
                )?;
            }
        }
        if items.is_empty() {
            let processing: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM character_reference_refresh_items
                 WHERE target_id=?1 AND request_revision=?2 AND state='processing'",
                params![target_id, request_revision],
                |row| row.get(0),
            )?;
            if processing == 0 && discovery_complete {
                let now = chrono::Utc::now().timestamp();
                transaction.execute(
                    "UPDATE character_reference_refreshes SET state=CASE WHEN failure_count>0 THEN 'failed' ELSE 'completed' END,completed_at=?3,updated_at=?3
                     WHERE target_id=?1 AND request_revision=?2",
                    params![target_id,request_revision,now],
                )?;
            }
            transaction.commit()?;
            return Ok(0);
        }
        let now = chrono::Utc::now().timestamp();
        transaction.execute(
            "UPDATE character_reference_refreshes SET state='running',started_at=COALESCE(started_at,?3),updated_at=?3
             WHERE target_id=?1 AND request_revision=?2",
            params![target_id,request_revision,now],
        )?;
        let mut fed = 0usize;
        let mut terminal = 0i64;
        for (asset_id, planned_generation) in items {
            let current: Option<(i64, String, String)> = transaction
                .query_row(
                    "SELECT generation,state,cause FROM character_autotag_jobs WHERE asset_id=?1",
                    [&asset_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let scope_is_current = refresh_eligible(&transaction, &target_id, &series_id, &asset_id)?;
            if !scope_is_current {
                transaction.execute(
                    "UPDATE character_reference_refresh_items SET state='superseded',updated_at=?4
                     WHERE target_id=?1 AND request_revision=?2 AND asset_id=?3 AND state='pending'",
                    params![target_id,request_revision,asset_id,now],
                )?;
                terminal += 1;
                continue;
            }
            let (current_generation, current_state, current_cause) = current.unwrap_or_default();
            let active = matches!(current_state.as_str(), "pending" | "processing");
            if active && current_cause != "reconsideration" {
                continue;
            }
            let attach_existing = active
                && current_cause == "reconsideration"
                && current_generation == planned_generation;
            let mut expected_generation = planned_generation;
            let changed = if attach_existing {
                true
            } else {
                expected_generation = current_generation + 1;
                if expected_generation != planned_generation {
                    transaction.execute(
                        "UPDATE character_reference_refresh_items SET generation=?4,updated_at=?5
                         WHERE target_id=?1 AND request_revision=?2 AND asset_id=?3 AND state='pending'",
                        params![target_id,request_revision,asset_id,expected_generation,now],
                    )?;
                }
                super::character_autotag::enqueue(
                    &transaction,
                    &asset_id,
                    super::character_autotag::Cause::Reconsideration,
                )?
            };
            let queued: Option<(i64, String)> = transaction
                .query_row(
                    "SELECT generation,state FROM character_autotag_jobs WHERE asset_id=?1",
                    [&asset_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if changed
                && queued.as_ref().is_some_and(|(generation, state)| {
                    *generation == expected_generation && state == "pending"
                })
            {
                transaction.execute(
                    "UPDATE character_reference_refresh_items SET state='processing',updated_at=?4
                     WHERE target_id=?1 AND request_revision=?2 AND asset_id=?3 AND state='pending'",
                    params![target_id,request_revision,asset_id,now],
                )?;
                fed += 1;
            } else {
                transaction.execute(
                    "UPDATE character_reference_refresh_items SET state='superseded',updated_at=?4
                     WHERE target_id=?1 AND request_revision=?2 AND asset_id=?3 AND state='pending'",
                    params![target_id,request_revision,asset_id,now],
                )?;
                terminal += 1;
            }
        }
        if terminal > 0 {
            transaction.execute(
                "UPDATE character_reference_refreshes SET visited_count=visited_count+?3,updated_at=?4
                 WHERE target_id=?1 AND request_revision=?2",
                params![target_id,request_revision,terminal,now],
            )?;
        }
        transaction.commit()?;
        Ok(fed)
    }

    #[cfg(test)]
    pub(super) fn reference_refresh_delta_evidence(
        &self,
        connection: &rusqlite::Connection,
        job: &Job,
        target_id: &str,
        runtime: &str,
        current_hashes: &[String],
    ) -> Result<Option<Value>> {
        let target = self.read_character_target(connection, target_id)?;
        Ok(
            match self.reference_refresh_evidence_reuse(
                connection,
                job,
                &target,
                runtime,
                current_hashes,
            )? {
                Some(ReferenceRefreshEvidenceReuse::Delta(value)) => Some(value),
                _ => None,
            },
        )
    }

    pub(super) fn reference_refresh_evidence_reuse(
        &self,
        connection: &rusqlite::Connection,
        job: &Job,
        target: &super::characters::Target,
        runtime: &str,
        current_hashes: &[String],
    ) -> Result<Option<ReferenceRefreshEvidenceReuse>> {
        if job.cause != "reconsideration" {
            return Ok(None);
        }
        let base: Option<String> = connection
            .query_row(
                "SELECT base_evidence_id FROM character_reference_refresh_items
                 WHERE asset_id=?2 AND generation=?3 AND state='processing'
                   AND base_evidence_id IS NOT NULL
                 ORDER BY CASE WHEN target_id=?1 THEN 0 ELSE 1 END,target_id LIMIT 1",
                params![target.id, job.asset_id, job.generation],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let Some(base_evidence_id) = base else {
            return Ok(None);
        };
        let prior: Option<(String, i64, String, String, String, String)> = connection
            .query_row(
                "SELECT e.content_hash,e.source_generation,e.runtime_fingerprint,
                        p.series_id,p.target_fingerprint,p.result_json
             FROM character_autotag_evidence e
             JOIN character_autotag_predictions p ON p.evidence_id=e.id
             WHERE e.id=?1 AND p.target_id=?2",
                params![base_evidence_id, target.id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            content_hash,
            source_generation,
            old_runtime,
            series_id,
            target_fingerprint,
            result_json,
        )) = prior
        else {
            return Ok(None);
        };
        if content_hash != job.content_hash
            || source_generation != job.source_generation
            || old_runtime != runtime
            || Some(series_id.as_str()) != target.series_classification_id.as_deref()
            || target_fingerprint != target.fingerprint
        {
            return Ok(None);
        }
        let result: Value = serde_json::from_str(&result_json)?;
        let Some(evidence) = result
            .get("evidence")
            .filter(|value| value.is_object())
            .cloned()
        else {
            return Ok(None);
        };
        if evidence["type"] != "result"
            || evidence["assetId"] != job.asset_id
            || evidence["baselineFingerprint"] != super::character_worker::BASELINE
            || evidence["contentHash"] != job.content_hash
            || !evidence["passed"].is_boolean()
            || !evidence["distance"]
                .as_f64()
                .is_some_and(|value| value.is_finite())
        {
            return Ok(None);
        }
        let old_hashes = evidence["referenceHashes"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if old_hashes == current_hashes {
            return Ok(Some(ReferenceRefreshEvidenceReuse::Exact(evidence)));
        }
        if old_hashes.len() >= 5
            && old_hashes.len() < current_hashes.len()
            && current_hashes.starts_with(&old_hashes)
        {
            return Ok(Some(ReferenceRefreshEvidenceReuse::Delta(evidence)));
        }
        Ok(None)
    }

    pub(super) fn complete_reference_refresh_item(
        &self,
        transaction: &rusqlite::Transaction<'_>,
        job: &Job,
        used_delta_targets: &BTreeSet<String>,
        compared: bool,
        published: bool,
    ) -> Result<()> {
        if job.cause != "reconsideration" {
            return Ok(());
        }
        let items = transaction
            .prepare(
                "SELECT target_id,request_revision FROM character_reference_refresh_items
             WHERE asset_id=?1 AND generation=?2 AND state='processing' ORDER BY target_id",
            )?
            .query_map(params![job.asset_id, job.generation], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let now = chrono::Utc::now().timestamp();
        for (target_id, request_revision) in items {
            let used_delta = used_delta_targets.contains(&target_id);
            let used_fallback = compared && !used_delta;
            transaction.execute(
                "UPDATE character_reference_refresh_items SET state='completed',used_delta=?4,error=NULL,updated_at=?5
                 WHERE target_id=?1 AND request_revision=?2 AND asset_id=?3 AND state='processing'",
                params![target_id,request_revision,job.asset_id,i64::from(used_delta),now],
            )?;
            transaction.execute(
                "UPDATE character_reference_refreshes SET visited_count=visited_count+1,
                    delta_count=delta_count+?3,fallback_count=fallback_count+?4,
                    published_count=published_count+?5,updated_at=?6
                 WHERE target_id=?1 AND request_revision=?2",
                params![
                    target_id,
                    request_revision,
                    i64::from(used_delta),
                    i64::from(used_fallback),
                    i64::from(published),
                    now
                ],
            )?;
            let remaining: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM character_reference_refresh_items
                 WHERE target_id=?1 AND request_revision=?2 AND state IN ('pending','processing')",
                params![target_id, request_revision],
                |row| row.get(0),
            )?;
            let discovery_complete: bool = transaction.query_row(
                "SELECT discovery_complete FROM character_reference_refreshes
                 WHERE target_id=?1 AND request_revision=?2",
                params![target_id, request_revision],
                |row| row.get(0),
            )?;
            if remaining == 0 && discovery_complete {
                transaction.execute(
                    "UPDATE character_reference_refreshes SET state=CASE WHEN failure_count>0 THEN 'failed' ELSE 'completed' END,completed_at=?3,updated_at=?3
                     WHERE target_id=?1 AND request_revision=?2 AND state IN ('pending','running')",
                    params![target_id,request_revision,now],
                )?;
            }
        }
        Ok(())
    }

    pub(super) fn fail_reference_refresh_item(&self, job: &Job, error: &str) -> Result<()> {
        if job.cause != "reconsideration" {
            return Ok(());
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let rows = transaction
            .prepare(
                "SELECT target_id,request_revision FROM character_reference_refresh_items
             WHERE asset_id=?1 AND generation=?2 AND state='processing'",
            )?
            .query_map(params![job.asset_id, job.generation], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let now = chrono::Utc::now().timestamp();
        for (target_id, request_revision) in rows {
            transaction.execute(
                "UPDATE character_reference_refresh_items SET state='failed',error=?4,updated_at=?5
                 WHERE target_id=?1 AND request_revision=?2 AND asset_id=?3 AND state='processing'",
                params![target_id, request_revision, job.asset_id, error, now],
            )?;
            transaction.execute(
                "UPDATE character_reference_refreshes SET visited_count=visited_count+1,
                    failure_count=failure_count+1,last_error=?3,updated_at=?4
                 WHERE target_id=?1 AND request_revision=?2",
                params![target_id, request_revision, error, now],
            )?;
            let remaining: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM character_reference_refresh_items
                 WHERE target_id=?1 AND request_revision=?2 AND state IN ('pending','processing')",
                params![target_id, request_revision],
                |row| row.get(0),
            )?;
            let discovery_complete: bool = transaction.query_row(
                "SELECT discovery_complete FROM character_reference_refreshes
                 WHERE target_id=?1 AND request_revision=?2",
                params![target_id, request_revision],
                |row| row.get(0),
            )?;
            if remaining == 0 && discovery_complete {
                transaction.execute(
                    "UPDATE character_reference_refreshes SET state='failed',completed_at=?3,updated_at=?3
                     WHERE target_id=?1 AND request_revision=?2",
                    params![target_id,request_revision,now],
                )?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub(super) fn supersede_invalid_reference_refresh_job(&self, job: &Job) -> Result<bool> {
        if job.cause != "reconsideration" {
            return Ok(false);
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let has_refresh_item: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_reference_refresh_items
             WHERE asset_id=?1 AND generation=?2)",
            params![job.asset_id, job.generation],
            |row| row.get(0),
        )?;
        if !has_refresh_item {
            return Ok(false);
        }
        let rows = transaction.prepare(
            "SELECT i.target_id,i.request_revision,r.series_classification_id,r.target_revision,r.requested_reference_set_hash
             FROM character_reference_refresh_items i
             JOIN character_reference_refreshes r ON r.target_id=i.target_id AND r.request_revision=i.request_revision
             WHERE i.asset_id=?1 AND i.generation=?2 AND i.state='processing'"
        )?.query_map(params![job.asset_id,job.generation], |row| {
            Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?,row.get::<_,i64>(3)?,row.get::<_,String>(4)?))
        })?.collect::<std::result::Result<Vec<_>,_>>()?;
        if rows.is_empty() {
            transaction.execute(
                "UPDATE character_autotag_jobs SET state='superseded',review_state='superseded',claim_id=NULL,error=NULL,updated_at=?3
                 WHERE asset_id=?1 AND generation=?2 AND state='processing'",
                params![job.asset_id,job.generation,chrono::Utc::now().to_rfc3339()],
            )?;
            transaction.commit()?;
            return Ok(true);
        }
        let now = chrono::Utc::now().timestamp();
        let mut invalid = false;
        for (target_id, request_revision, series_id, target_revision, reference_hash) in rows {
            let target = self.read_character_target(&transaction, &target_id)?;
            let still_valid = target.revision == target_revision
                && reference_set_hash(&target)? == reference_hash
                && refresh_eligible(&transaction, &target_id, &series_id, &job.asset_id)?;
            if still_valid {
                continue;
            }
            invalid = true;
            transaction.execute(
                "UPDATE character_reference_refresh_items SET state='superseded',error=NULL,updated_at=?4
                 WHERE target_id=?1 AND request_revision=?2 AND asset_id=?3 AND state='processing'",
                params![target_id,request_revision,job.asset_id,now],
            )?;
            transaction.execute(
                "UPDATE character_reference_refreshes SET visited_count=visited_count+1,updated_at=?3
                 WHERE target_id=?1 AND request_revision=?2",
                params![target_id,request_revision,now],
            )?;
            let remaining: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM character_reference_refresh_items
                 WHERE target_id=?1 AND request_revision=?2 AND state IN ('pending','processing')",
                params![target_id, request_revision],
                |row| row.get(0),
            )?;
            let discovery_complete: bool = transaction.query_row(
                "SELECT discovery_complete FROM character_reference_refreshes
                 WHERE target_id=?1 AND request_revision=?2",
                params![target_id, request_revision],
                |row| row.get(0),
            )?;
            if remaining == 0 && discovery_complete {
                transaction.execute(
                    "UPDATE character_reference_refreshes SET state=CASE WHEN failure_count>0 THEN 'failed' ELSE 'completed' END,completed_at=?3,updated_at=?3
                     WHERE target_id=?1 AND request_revision=?2",
                    params![target_id,request_revision,now],
                )?;
            }
        }
        if invalid {
            transaction.execute(
                "UPDATE character_autotag_jobs SET state='superseded',review_state='superseded',claim_id=NULL,error=NULL,updated_at=?3
                 WHERE asset_id=?1 AND generation=?2 AND state='processing'",
                params![job.asset_id,job.generation,chrono::Utc::now().to_rfc3339()],
            )?;
        }
        transaction.commit()?;
        Ok(invalid)
    }
}

#[cfg(test)]
#[path = "character_reference_refresh_tests.rs"]
mod tests;
