//! Native queue consumer. One complete asset result is the publication unit.
use super::{
    character_autotag::{self, Context, Job, Prediction, ReviewState},
    character_scan::{automatic_evidence, evidence_regions, same_person, ScanResult},
    character_sources::Source,
    character_worker::{RuntimeConfig, BASELINE},
    characters::{Error, Result},
    Library,
};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Debug, Default)]
pub(super) struct Engine {
    running: bool,
    stop: Arc<AtomicBool>,
    active: Option<String>,
    total: usize,
    compared: usize,
    error: Option<String>,
    config: Option<RuntimeConfig>,
    next_config: Option<RuntimeConfig>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    running: bool,
    paused: bool,
    pending: i64,
    completed: i64,
    confirmed: i64,
    active_asset_id: Option<String>,
    total: usize,
    compared: usize,
    error: Option<String>,
}
impl Library {
    pub fn start_character_incremental(&self, config: RuntimeConfig) {
        let mut engine = self
            .character_incremental
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if engine.running {
            if engine.config.as_ref() != Some(&config) {
                engine.next_config = Some(config);
                engine.stop.store(true, Ordering::Release);
            }
            return;
        }
        engine.config = Some(config.clone());
        engine.next_config = None;
        engine.running = true;
        engine.error = None;
        engine.stop = Arc::new(AtomicBool::new(false));
        let stop = engine.stop.clone();
        let library = self.clone();
        drop(engine);
        if let Err(error) = self.recover_character_autotag() {
            let mut e = self
                .character_incremental
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            e.running = false;
            e.error = Some(error.to_string());
            return;
        }
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                library.incremental_loop(config, stop.clone())
            }));
            let mut engine = library
                .character_incremental
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            engine.running = false;
            engine.active = None;
            if result.is_err() {
                engine.error = Some("자동 분석 작업이 중단되었습니다. 재개해 주세요.".into());
            }
            let next = engine.next_config.take();
            drop(engine);
            if let Some(config) = next {
                library.start_character_incremental(config);
            }
        });
    }
    pub(crate) fn stop_character_incremental(&self) {
        let mut engine = self
            .character_incremental
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        engine.next_config = None;
        engine.stop.store(true, Ordering::Release);
    }
    pub fn character_incremental_status(&self) -> Result<Status> {
        let (running, active, total, compared, error) = {
            let e = self
                .character_incremental
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            (
                e.running,
                e.active.clone(),
                e.total,
                e.compared,
                e.error.clone(),
            )
        };
        let c = self.connection()?;
        let (paused, completed, confirmed) = c.query_row(
            "SELECT paused,completed,confirmed FROM character_autotag_control WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let pending = c.query_row(
            "SELECT COUNT(*) FROM character_autotag_jobs WHERE state='pending'",
            [],
            |r| r.get(0),
        )?;
        Ok(Status {
            running,
            paused,
            pending,
            completed,
            confirmed,
            active_asset_id: active,
            total,
            compared,
            error,
        })
    }
    pub fn set_character_incremental_paused(&self, paused: bool) -> Result<()> {
        self.connection()?.execute(
            "UPDATE character_autotag_control SET paused=?1 WHERE singleton=1",
            [paused],
        )?;
        Ok(())
    }
    fn incremental_loop(&self, config: RuntimeConfig, stop: Arc<AtomicBool>) {
        while !stop.load(Ordering::Acquire) && Arc::strong_count(&self.lease) > 1 {
            let attempt = (|| -> Result<bool> {
                if self.character_incremental_status()?.paused {
                    return Ok(false);
                }
                let Some(job) = self.claim_character_autotag()? else {
                    self.advance_character_reconsideration()?;
                    return Ok(false);
                };
                {
                    let mut e = self
                        .character_incremental
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    e.active = Some(job.asset_id.clone());
                    e.total = 0;
                    e.compared = 0;
                }
                let outcome = self.compare_incremental_asset(&job, &config, stop.clone());
                if let Err(error) = outcome {
                    let stopped = stop.load(Ordering::Acquire);
                    let retry = stopped || job.attempts < 3;
                    let c = self.connection()?;
                    // The claim token also fences restore/library-switch races.
                    c.execute("UPDATE character_autotag_jobs SET state=?3,claim_id=NULL,error=?4,review_state=?5,retry_at=?6
                        WHERE asset_id=?1 AND claim_id=?2",params![job.asset_id,job.claim_id,if retry{"pending"}else{"failed"},error.to_string(),
                        if retry{"unresolved"}else{"failed"},chrono::Utc::now().timestamp()+if stopped{0}else{job.attempts*2}])?;
                    drop(c);
                    self.character_incremental
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .error = Some(error.to_string());
                } else {
                    self.character_incremental
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .error = None;
                }
                self.character_incremental
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .active = None;
                Ok(true)
            })();
            if !matches!(attempt, Ok(true)) {
                if let Err(error) = attempt {
                    self.character_incremental
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .error = Some(error.to_string());
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
    fn advance_character_reconsideration(&self) -> Result<()> {
        let change:Option<(String,i64,Option<String>)>=self.connection()?.query_row("SELECT series_id,revision,after_asset FROM character_autotag_reconsideration ORDER BY series_id LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((series, revision, after)) = change {
            let ids = self.reconsider_character_autotag(&series, after.as_deref(), 32)?;
            let c = self.connection()?;
            if let Some(last) = ids.last() {
                c.execute("UPDATE character_autotag_reconsideration SET after_asset=?3 WHERE series_id=?1 AND revision=?2",params![series,revision,last])?;
            } else {
                c.execute("DELETE FROM character_autotag_reconsideration WHERE series_id=?1 AND revision=?2",params![series,revision])?;
            }
        }
        Ok(())
    }
    fn compare_incremental_asset(
        &self,
        job: &Job,
        config: &RuntimeConfig,
        stop: Arc<AtomicBool>,
    ) -> Result<()> {
        // Empty rosters require no model process and still get a durable checkpoint.
        let initial = {
            let c = self.connection()?;
            self.character_autotag_context(&c, job, "awaiting-runtime")?
        };
        if initial.targets.is_empty() {
            let mut c = self.connection()?;
            let tx = c.transaction()?;
            if stop.load(Ordering::Acquire) {
                return Err(Error::Stale);
            }
            self.publish_character_autotag(
                &tx,
                job,
                &initial,
                &[],
                ReviewState::AwaitingCandidates,
                &json!([]),
            )?;
            tx.commit()?;
            return Ok(());
        }
        let cache = self.root.join(".cache/characters");
        let ready =
            self.character_worker_pool
                .with(config, &cache, stop.clone(), false, |_, ready| {
                    Ok(ready.clone())
                })?;
        let runtime = ready["runtimeFingerprint"]
            .as_str()
            .filter(|s| s.len() == 64)
            .ok_or_else(|| Error::Worker("분석 환경 식별자 오류".into()))?;
        let (context, reference_paths, decision_sequence) = {
            let c = self.connection()?;
            let context = self.character_autotag_context(&c, job, runtime)?;
            let mut paths = BTreeMap::new();
            for target in &context.targets {
                for reference in target.references.iter().chain(&target.learned_references) {
                    let id = reference.asset_id.as_ref().ok_or(Error::Stale)?;
                    let (hash, path) = super::characters::scoped_image(
                        &c,
                        target
                            .series_classification_id
                            .as_deref()
                            .ok_or(Error::Stale)?,
                        id,
                    )?;
                    if hash != reference.asset_hash {
                        return Err(Error::Stale);
                    }
                    paths.insert(id.clone(), (hash, path));
                }
            }
            let sequence:i64=c.query_row("SELECT COALESCE(MAX(sequence),0) FROM character_decisions WHERE source_asset_id=?1",[&job.asset_id],|r|r.get(0))?;
            (context, paths, sequence)
        };
        if context.targets.is_empty() {
            return Err(Error::Stale);
        }
        let query = Source::capture(self, &job.relative_path, &job.content_hash)?;
        let mut sources = BTreeMap::new();
        for (id, (hash, path)) in &reference_paths {
            if stop.load(Ordering::Acquire) {
                return Err(Error::Stale);
            }
            sources.insert(id.clone(), Source::capture(self, path, hash)?);
        }
        self.character_incremental
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .total = context.targets.len();
        let is_reference = reference_paths
            .values()
            .any(|(hash, _)| hash == &job.content_hash);
        let predictions=self.character_worker_pool.with(config,&cache,stop.clone(),false,|worker,worker_ready| {
            if worker_ready["runtimeFingerprint"]!=runtime {return Err(Error::Stale);}
            worker.send(&json!({"type":"load_query","assetId":job.asset_id,"hash":job.content_hash,"path":query.path()}))?;
            let loaded=worker.receive()?;
            if loaded["type"]!="query_loaded" || loaded["assetId"]!=job.asset_id || loaded["contentHash"]!=job.content_hash {return Err(Error::Worker("이미지 특징을 불러오지 못했습니다.".into()));}
            let mut predictions=Vec::new();
            for target in &context.targets {
                let refs=target.references.iter().chain(&target.learned_references).map(|r|{
                    let id=r.asset_id.as_ref().ok_or(Error::Stale)?;
                    Ok(json!({"assetId":id,"hash":r.asset_hash,"path":sources.get(id).ok_or(Error::Stale)?.path()}))
                }).collect::<Result<Vec<_>>>()?;
                let hashes=refs.iter().map(|r|r["hash"].clone()).collect::<Vec<_>>();
                worker.send(&json!({"type":"prepare","references":refs}))?;
                let prepared=worker.receive()?;
                if prepared["type"]!="prepared" || prepared["referenceHashes"]!=json!(hashes) {return Err(Error::Worker("기준 이미지 준비 실패".into()));}
                worker.send(&json!({"type":"compare_query","assetId":job.asset_id,"hash":job.content_hash}))?;
                let result=worker.receive()?;
                if result["type"]!="result" || result["assetId"]!=job.asset_id || result["contentHash"]!=job.content_hash
                    || result["referenceHashes"]!=json!(hashes) || result["baselineFingerprint"]!=BASELINE
                    || !result["passed"].is_boolean() || !result["distance"].as_f64().is_some_and(|v|v.is_finite()) {
                    return Err(Error::Worker("캐릭터 비교 응답 검증 실패".into()));
                }
                predictions.push(Prediction{target_id:target.id.clone(),result:ScanResult{asset_id:job.asset_id.clone(),content_hash:job.content_hash.clone(),
                    state:if result["passed"]==true{"recommended"}else{"unmatched"}.into(),evidence:Some(result),error:None}});
                self.character_incremental.lock().unwrap_or_else(std::sync::PoisonError::into_inner).compared=predictions.len();
            }
            Ok(predictions)
        })?;
        // Full reads happen once per distinct source, outside the global DB lock.
        query.verify(self)?;
        for source in sources.values() {
            source.verify(self)?;
        }
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        if stop.load(Ordering::Acquire) {
            return Err(Error::Stale);
        }
        query.check_identity(self)?;
        for source in sources.values() {
            source.check_identity(self)?;
        }
        let current: i64 = tx.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM character_decisions WHERE source_asset_id=?1",
            [&job.asset_id],
            |r| r.get(0),
        )?;
        if current != decision_sequence {
            return Err(Error::Stale);
        }
        self.finalize_incremental(&tx, job, &context, &predictions, is_reference)?;
        query.check_identity(self)?;
        for source in sources.values() {
            source.check_identity(self)?;
        }
        if stop.load(Ordering::Acquire) {
            return Err(Error::Stale);
        }
        tx.commit()?;
        Ok(())
    }
    fn finalize_incremental(
        &self,
        tx: &rusqlite::Transaction<'_>,
        job: &Job,
        context: &Context,
        predictions: &[Prediction],
        is_reference: bool,
    ) -> Result<()> {
        let decisions=tx.prepare("SELECT target_id,decision,origin FROM character_decisions WHERE source_asset_id=?1 ORDER BY sequence DESC")?
            .query_map([&job.asset_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let blocked = decisions
            .iter()
            .filter(|(_, d, _)| matches!(d.as_str(), "rejected" | "cleared"))
            .map(|(id, _, _)| id.as_str())
            .collect::<BTreeSet<_>>();
        let candidates = predictions
            .iter()
            .filter(|p| !blocked.contains(p.target_id.as_str()))
            .collect::<Vec<_>>();
        let mut accepted = Vec::new();
        let mut covered = Vec::new();
        let boxes = predictions
            .first()
            .and_then(|p| p.result.evidence.as_ref())
            .and_then(|e| e["queryBoxes"].as_array())
            .cloned()
            .unwrap_or_default();
        let mut latest = BTreeMap::new();
        for (id, decision, _) in &decisions {
            latest.entry(id).or_insert(decision);
        }
        let known = latest
            .values()
            .any(|decision| decision.as_str() == "accepted");
        for p in &candidates {
            let evidence = p.result.evidence.as_ref();
            if is_reference || !automatic_evidence(evidence) {
                continue;
            }
            let Some(regions) = evidence_regions(evidence, 3) else {
                continue;
            };
            let unique = regions
                .iter()
                .filter(|region| {
                    candidates
                        .iter()
                        .filter(|other| other.target_id != p.target_id)
                        .all(|other| {
                            evidence_regions(other.result.evidence.as_ref(), 2).is_some_and(
                                |others| others.iter().all(|r| !same_person(region, r)),
                            )
                        })
                })
                .copied()
                .collect::<Vec<_>>();
            if unique.is_empty() {
                continue;
            }
            if decisions.iter().any(|(id, _, _)| id == &p.target_id) {
                if decisions
                    .iter()
                    .find(|(id, _, _)| id == &p.target_id)
                    .is_some_and(|(_, d, _)| d == "accepted")
                {
                    covered.extend(unique);
                }
                continue;
            }
            if known && boxes.len() == 1 {
                continue;
            }
            covered.extend(unique);
            accepted.push(*p);
        }
        let unresolved = boxes
            .iter()
            .filter(|b| box_array(b).is_none_or(|r| !covered.iter().any(|c| same_person(&r, c))))
            .cloned()
            .collect::<Vec<_>>();
        let resolved = is_reference
            || (known && boxes.len() == 1)
            || (!boxes.is_empty() && unresolved.is_empty());
        let review = if resolved {
            ReviewState::Resolved
        } else if known || !accepted.is_empty() {
            ReviewState::PartiallyResolved
        } else {
            ReviewState::Unresolved
        };
        let evidence_id = self.publish_character_autotag(
            tx,
            job,
            context,
            predictions,
            review,
            &json!(unresolved),
        )?;
        for p in &accepted {
            let target = context
                .targets
                .iter()
                .find(|t| t.id == p.target_id)
                .ok_or(Error::Stale)?;
            let mut evidence = p.result.evidence.clone().ok_or(Error::Stale)?;
            evidence["learnedReferences"] = json!(target.learned_references);
            evidence["automaticScope"] = json!(true);
            let snapshot = json!({"scanId":evidence_id,"runtimeFingerprint":context.runtime,"prediction":evidence,"references":target.references});
            tx.execute("INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,baseline_fingerprint,reference_snapshot,origin,created_at)
                VALUES(?1,?2,?2,?3,'accepted',?4,?5,?6,'automatic',?7)",params![target.id,job.asset_id,job.content_hash,target.fingerprint,context.runtime,serde_json::to_string(&snapshot)?,chrono::Utc::now().to_rfc3339()])?;
        }
        if !accepted.is_empty() {
            let series=tx.prepare("SELECT DISTINCT t.series_classification_id FROM character_relations r JOIN character_targets t ON t.id=r.target_id WHERE r.asset_id=?1 AND t.series_classification_id IS NOT NULL")?
                .query_map([&job.asset_id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
            if series.len() == 1 {
                let at_root:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM asset_classifications a JOIN classification_entries c ON c.id=a.classification_id WHERE a.asset_id=?1 AND c.parent_id IS NULL AND c.id<>?2)",params![job.asset_id,series[0]],|r|r.get(0))?;
                if at_root {
                    Self::set_asset_classification_cause_in(
                        tx,
                        &super::models::SetAssetClassification {
                            asset_ids: vec![job.asset_id.clone()],
                            classification_id: Some(series[0].clone()),
                        },
                        character_autotag::Cause::AutomaticFinalization,
                    )?;
                }
            }
        }
        tx.execute("UPDATE character_autotag_control SET completed=completed+1,confirmed=confirmed+?1 WHERE singleton=1",[accepted.len() as i64])?;
        Ok(())
    }
}
fn box_array(value: &Value) -> Option<[f64; 4]> {
    let b = value.as_array()?;
    if b.len() != 4 {
        return None;
    }
    let r = [
        b[0].as_f64()?,
        b[1].as_f64()?,
        b[2].as_f64()?,
        b[3].as_f64()?,
    ];
    (r.iter().all(|n| n.is_finite()) && r[2] > r[0] && r[3] > r[1]).then_some(r)
}

#[cfg(test)]
#[path = "character_incremental_tests.rs"]
mod tests;
