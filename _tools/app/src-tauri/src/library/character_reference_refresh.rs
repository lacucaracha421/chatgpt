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

pub(super) enum ReferenceRefreshEvidenceReuse {
    Exact(Value),
    Delta(Value),
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
        transaction.execute(
            "UPDATE character_reference_refreshes SET discovery_complete=0,updated_at=?3,
                through_job_sequence=(SELECT COALESCE(MAX(sequence),0) FROM character_autotag_admissions)
             WHERE target_id=?1 AND request_revision=?2",
            params![target_id, request_revision, now],
        )?;
        transaction.commit()?;
        Ok(ReferenceRefreshReceipt {
            target_id: target_id.into(),
            request_revision,
            state: ReferenceRefreshState::Pending,
            eligible_count: 0,
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
                    let scope =
                        super::character_scope::resolve_character_scope(&transaction, &asset_id)?;
                    let latest_origin: Option<String> = transaction.query_row(
                        "SELECT origin FROM character_decisions WHERE target_id=?1 AND source_asset_id=?2 ORDER BY sequence DESC LIMIT 1",
                        params![target_id, asset_id], |row| row.get(0),
                    ).optional()?;
                    if !scope
                        .as_ref()
                        .is_some_and(|scope| scope.series_classification_ids.contains(&series_id))
                        || latest_origin.as_deref() == Some("manual")
                    {
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
            let scope = super::character_scope::resolve_character_scope(&transaction, &asset_id)?;
            let manual: Option<String> = transaction.query_row(
                "SELECT origin FROM character_decisions WHERE target_id=?1 AND source_asset_id=?2 ORDER BY sequence DESC LIMIT 1",
                params![target_id,asset_id], |row| row.get(0),
            ).optional()?;
            let current: Option<(i64, String, String)> = transaction
                .query_row(
                    "SELECT generation,state,cause FROM character_autotag_jobs WHERE asset_id=?1",
                    [&asset_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let scope_is_current = scope
                .as_ref()
                .is_some_and(|scope| scope.series_classification_ids.contains(&series_id))
                && manual.as_deref() != Some("manual");
            if !scope_is_current {
                transaction.execute(
                    "UPDATE character_reference_refresh_items SET state='superseded',updated_at=?4
                     WHERE target_id=?1 AND request_revision=?2 AND asset_id=?3 AND state='pending'",
                    params![target_id,request_revision,asset_id,now],
                )?;
                terminal += 1;
                continue;
            }
            let Some((current_generation, current_state, current_cause)) = current else {
                transaction.execute(
                    "UPDATE character_reference_refresh_items SET state='superseded',updated_at=?4
                     WHERE target_id=?1 AND request_revision=?2 AND asset_id=?3 AND state='pending'",
                    params![target_id,request_revision,asset_id,now],
                )?;
                terminal += 1;
                continue;
            };
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
            let scope =
                super::character_scope::resolve_character_scope(&transaction, &job.asset_id)?;
            let latest_origin: Option<String> = transaction.query_row(
                "SELECT origin FROM character_decisions WHERE target_id=?1 AND source_asset_id=?2 ORDER BY sequence DESC LIMIT 1",
                params![target_id,job.asset_id], |row| row.get(0),
            ).optional()?;
            let still_valid = target.revision == target_revision
                && reference_set_hash(&target)? == reference_hash
                && scope
                    .as_ref()
                    .is_some_and(|scope| scope.series_classification_ids.contains(&series_id))
                && latest_origin.as_deref() != Some("manual");
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
