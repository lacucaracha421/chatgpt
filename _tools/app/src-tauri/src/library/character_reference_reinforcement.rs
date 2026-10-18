//! Quiet reinforcement only reuses by-hand candidates; cached one-person evidence is
//! mandatory. The native character owner performs one atomic, append-only run at a time.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::{
    character_reference_candidates::{
        reference_set_hash, ConfirmReferenceBatch, ReferenceConfirmationMode,
    },
    character_reference_regions::{RegionBinding, RegionBindings},
    character_sources::Source,
    characters::{Error, Result, Target, MAX_REFERENCES},
    Library,
};

// Same 256-bit perceptual Hamming measure and duplicate cut as semantic curation:
// <=16 bits is withheld; automatic additions need at least 17 bits of separation.
// Missing/low-quality fingerprints cannot establish safety, even for an anchor.
const MINIMUM_DISTANCE: u32 = 17;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReinforcementRun {
    pub run_id: String,
    pub asset_ids: Vec<String>,
    pub at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReinforcementCandidate {
    pub asset_id: String,
    pub hash: String,
    /// Unknown detection is null, distinct from a detector finding zero people.
    pub persons: Option<usize>,
    pub safe: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<RegionBinding>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceReinforcement {
    pub pending_run: Option<ReinforcementRun>,
    pub ghosts: Vec<ReinforcementCandidate>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddedReference {
    asset_id: String,
    hash: String,
    created_at: String,
}

fn fingerprint(c: &Connection, id: &str) -> Result<Option<[u8; 32]>> {
    let (bytes, quality): (Option<Vec<u8>>, Option<i64>) = c.query_row(
        "SELECT perceptual_hash,perceptual_hash_quality FROM assets WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(bytes
        .filter(|v| matches!(v.len(), 32 | 64) && quality.unwrap_or(0) >= 50)
        .and_then(|v| v[..32].try_into().ok()))
}

fn automatic(target: &Target) -> bool {
    target.enabled
        && !target.manual_only
        && !target.is_extras()
        && target.references.len() >= 5
        && target.references.iter().all(|r| r.status == "ready")
}

impl Library {
    fn reinforcement_candidates_in(
        &self,
        c: &Connection,
        target: &Target,
    ) -> Result<Vec<ReinforcementCandidate>> {
        if !automatic(target) {
            return Ok(Vec::new());
        }
        let series = target
            .series_classification_id
            .as_deref()
            .ok_or(Error::Stale)?;
        let enabled: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM character_series WHERE classification_id=?1 AND auto_classify=1)",[series],|r|r.get(0))?;
        if !enabled {
            return Ok(Vec::new());
        }
        let mut seen = Vec::new();
        let mut seen_hashes = std::collections::BTreeSet::new();
        let mut complete = true;
        for reference in target.references.iter().chain(&target.learned_references) {
            seen_hashes.insert(reference.asset_hash.clone());
            // Unavailable references count towards capacity and cannot prove diversity.
            if reference.status != "ready" {
                complete = false;
                continue;
            }
            match reference
                .asset_id
                .as_deref()
                .map(|id| fingerprint(c, id))
                .transpose()?
                .flatten()
            {
                Some(fp) => seen.push(fp),
                None => complete = false,
            }
        }
        let mut result = Vec::new();
        let mut pool = self.reference_candidate_pool_in(c, target)?;
        // Preserve the existing quality/recency preference within the manual pool.
        pool.sort_by(|a, b| {
            b.quality
                .cmp(&a.quality)
                .then(b.sequence.cmp(&a.sequence))
                .then(a.asset_id.cmp(&b.asset_id))
        });
        for candidate in pool {
            let persons = candidate.detected_people.map(|v| v as usize);
            let region = if persons == Some(1) {
                candidate
                    .boxes
                    .as_ref()
                    .and_then(|v| v.as_array())
                    .and_then(|boxes| serde_json::from_value::<[u32; 4]>(boxes[0].clone()).ok())
                    .map(|bounds| RegionBinding {
                        content_hash: candidate.content_hash.clone(),
                        baseline_fingerprint: super::character_worker::BASELINE.into(),
                        bounds,
                    })
            } else {
                None
            };
            let region = match region {
                Some(region)
                    if super::character_reference_regions::is_person_region(
                        c,
                        series,
                        &candidate.asset_id,
                        &region,
                    )? =>
                {
                    Some(region)
                }
                _ => None,
            };
            let fp = fingerprint(c, &candidate.asset_id)?;
            let safe = complete
                && !seen_hashes.contains(&candidate.content_hash)
                && region.is_some()
                && fp.is_some_and(|fp| {
                    seen.iter().all(|other| {
                        super::image_fingerprint::hamming_distance(&fp, other) >= MINIMUM_DISTANCE
                    })
                });
            if safe {
                seen.push(fp.unwrap());
                seen_hashes.insert(candidate.content_hash.clone());
            }
            result.push(ReinforcementCandidate {
                asset_id: candidate.asset_id,
                hash: candidate.content_hash,
                persons,
                safe,
                region,
            });
        }
        Ok(result)
    }

    pub fn character_reference_reinforcement(
        &self,
        target_id: &str,
    ) -> Result<ReferenceReinforcement> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let target = self.read_character_target(&tx, target_id)?;
        let pending = tx.query_row(
            "SELECT run_id,references_json,created_at FROM character_reference_reinforcement_runs WHERE target_id=?1 AND state='pending'",
            [target_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)),
        ).optional()?;
        let pending_run = pending
            .map(|(run_id, json, at)| -> Result<_> {
                let refs: Vec<AddedReference> = serde_json::from_str(&json)?;
                Ok(ReinforcementRun {
                    run_id,
                    asset_ids: refs.into_iter().map(|r| r.asset_id).collect(),
                    at,
                })
            })
            .transpose()?;
        let ghosts = self.reinforcement_candidates_in(&tx, &target)?;
        Ok(ReferenceReinforcement {
            pending_run,
            ghosts,
        })
    }

    /// Called only by the existing background owner (and fixture tests). A pending receipt
    /// holds later work until it is seen/acknowledged, so an unseen undo never gets lost.
    pub(super) fn advance_character_reference_reinforcement(&self) -> Result<bool> {
        if crate::workload::is_restricted() {
            return Ok(false);
        }
        let (id, requested, target, selected, inputs) = {
            let c = self.connection()?;
            let queued: Option<(String,i64)> = c.query_row(
                "SELECT q.target_id,q.requested FROM character_reference_reinforcement_queue q
                 WHERE q.retry_at<=strftime('%s','now')
                   AND NOT EXISTS(SELECT 1 FROM character_reference_reinforcement_runs r WHERE r.target_id=q.target_id AND r.state='pending')
                 AND NOT EXISTS(SELECT 1 FROM character_autotag_control WHERE singleton=1 AND paused=1)
                 ORDER BY q.target_id LIMIT 1", [], |r|Ok((r.get(0)?,r.get(1)?)),
            ).optional()?;
            let Some((id, requested)) = queued else {
                return Ok(false);
            };
            let target = self.read_character_target(&c, &id)?;
            let capacity = MAX_REFERENCES
                .saturating_sub(target.references.len() + target.learned_references.len());
            let selected = self
                .reinforcement_candidates_in(&c, &target)?
                .into_iter()
                .filter(|r| r.safe)
                .take(capacity)
                .collect::<Vec<_>>();
            let mut inputs = Vec::new();
            if !selected.is_empty() {
                let series = target
                    .series_classification_id
                    .as_deref()
                    .ok_or(Error::Stale)?;
                for row in &selected {
                    let (hash, path) = super::characters::scoped_image(&c, series, &row.asset_id)?;
                    if hash != row.hash {
                        return Err(Error::Stale);
                    }
                    inputs.push((hash, path));
                }
                for reference in target.usable_references() {
                    let (hash, path) = super::characters::scoped_image(
                        &c,
                        series,
                        reference.asset_id.as_deref().ok_or(Error::Stale)?,
                    )?;
                    if hash != reference.asset_hash {
                        return Err(Error::Stale);
                    }
                    inputs.push((hash, path));
                }
            }
            (id, requested, target, selected, inputs)
        };
        let mut activity = crate::activities::Job::start(
            "reference-reinforcement",
            "reference_reinforcement",
            "레퍼런스 보강",
            Some("character"),
        );
        activity.progress(0, None, Some(target.display_name.clone()));
        let result = (|| {
            // Hash immutable sources without holding the library lock. Keep handles alive until
            // commit; Windows pins originals, and the final identity check detects replacements.
            let sources = (|| -> Result<_> {
                let sources = inputs
                    .iter()
                    .map(|(hash, path)| Source::capture(self, path, hash))
                    .collect::<Result<Vec<_>>>()?;
                for source in &sources {
                    source.verify(self)?;
                }
                Ok(sources)
            })();
            let sources = match sources {
                Ok(sources) => sources,
                Err(error) => {
                    // A missing or externally changed file must not monopolize the owner or
                    // block other characters. Retry on the normal idle safety interval.
                    self.connection()?.execute(
                    "UPDATE character_reference_reinforcement_queue SET retry_at=?3 WHERE target_id=?1 AND requested=?2",
                    params![id,requested,chrono::Utc::now().timestamp()+60],
                )?;
                    return Err(error);
                }
            };
            if crate::workload::is_restricted() {
                return Ok(false);
            }
            let mut c = self.connection()?;
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current = self.read_character_target(&tx, &id)?;
            if current.revision != target.revision
                || reference_set_hash(&current)? != reference_set_hash(&target)?
            {
                return Err(Error::Stale);
            }
            let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM character_reference_reinforcement_runs WHERE target_id=?1 AND state='pending')",[&id],|r|r.get(0))?;
            let paused: bool = tx.query_row(
                "SELECT paused FROM character_autotag_control WHERE singleton=1",
                [],
                |r| r.get(0),
            )?;
            if pending || paused {
                return Ok(false);
            }
            let eligible = self.reinforcement_candidates_in(&tx, &current)?;
            for row in &selected {
                if !eligible.iter().any(|now| {
                    now.safe
                        && now.asset_id == row.asset_id
                        && now.hash == row.hash
                        && now.region == row.region
                }) {
                    return Err(Error::Stale);
                }
            }
            for source in &sources {
                source.check_identity(self)?;
            }
            if !selected.is_empty() {
                let ids = selected
                    .iter()
                    .map(|r| r.asset_id.clone())
                    .collect::<Vec<_>>();
                let regions: RegionBindings = selected
                    .into_iter()
                    .map(|r| (r.asset_id, r.region.unwrap()))
                    .collect();
                self.confirm_reference_batch_in(
                    &tx,
                    ConfirmReferenceBatch {
                        target_id: id.clone(),
                        expected_revision: target.revision,
                        expected_reference_set_hash: reference_set_hash(&target)?,
                        confirmation_mode: ReferenceConfirmationMode::AddLearned,
                        asset_ids: ids.clone(),
                    },
                    regions,
                )?;
                let mut refs = Vec::new();
                for asset_id in ids {
                    let (hash,created_at) = tx.query_row("SELECT asset_hash,created_at FROM character_learned_references WHERE target_id=?1 AND asset_id=?2",params![id,asset_id],|r|Ok((r.get(0)?,r.get(1)?)))?;
                    refs.push(AddedReference {
                        asset_id,
                        hash,
                        created_at,
                    });
                }
                tx.execute("INSERT INTO character_reference_reinforcement_runs(run_id,target_id,references_json,created_at,state) VALUES(?1,?2,?3,?4,'pending')",
                params![uuid::Uuid::new_v4().to_string(),id,serde_json::to_string(&refs)?,chrono::Utc::now().to_rfc3339()])?;
            }
            tx.execute("DELETE FROM character_reference_reinforcement_queue WHERE target_id=?1 AND requested=?2",params![id,requested])?;
            tx.commit()?;
            Ok(true)
        })();
        if matches!(result, Ok(false)) {
            activity.defer(crate::workload::is_restricted().then(|| "절약 모드".into()));
        } else { activity.complete(&result); }
        result
    }

    pub fn acknowledge_reference_reinforcement(&self, target_id: &str, run_id: &str) -> Result<()> {
        let c = self.connection()?;
        self.reinforcement_run_in(&c, target_id, run_id)?;
        c.execute("UPDATE character_reference_reinforcement_runs SET state='acknowledged' WHERE target_id=?1 AND run_id=?2 AND state='pending'",params![target_id,run_id])?;
        Ok(())
    }

    fn reinforcement_run_in(
        &self,
        c: &Connection,
        target_id: &str,
        run_id: &str,
    ) -> Result<(Vec<AddedReference>, String)> {
        let row = c.query_row("SELECT references_json,state FROM character_reference_reinforcement_runs WHERE target_id=?1 AND run_id=?2",params![target_id,run_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?.ok_or(Error::NotFound)?;
        Ok((serde_json::from_str(&row.0)?, row.1))
    }

    pub fn undo_reference_reinforcement(&self, target_id: &str, run_id: &str) -> Result<Target> {
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (refs, state) = self.reinforcement_run_in(&tx, target_id, run_id)?;
        let mut target = self.read_character_target(&tx, target_id)?;
        if state != "undone" {
            for row in refs {
                // An individually removed and later manually re-added reference is no
                // longer owned by this run. Never undo that later user action.
                let still_owned: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM character_learned_references WHERE target_id=?1 AND asset_id=?2 AND asset_hash=?3 AND created_at=?4)",params![target_id,row.asset_id,row.hash,row.created_at],|r|r.get(0))?;
                if still_owned {
                    target = self.exclude_character_reference_in(
                        &tx,
                        target_id,
                        target.revision,
                        &row.asset_id,
                    )?;
                }
            }
            tx.execute("UPDATE character_reference_reinforcement_runs SET state='undone' WHERE target_id=?1 AND run_id=?2",params![target_id,run_id])?;
        }
        tx.commit()?;
        Ok(target)
    }
}

#[cfg(test)]
#[path = "character_reference_reinforcement_tests.rs"]
mod tests;
