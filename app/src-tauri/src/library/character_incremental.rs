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
    time::{Duration, Instant},
};

#[derive(Debug, PartialEq, Eq)]
struct PreparedKey {
    runtime: String,
    targets: Vec<(String, String, Vec<(String, String, String)>)>,
}
#[derive(Debug)]
struct PreparedReferences {
    key: PreparedKey,
    sources: BTreeMap<String, Arc<Source>>,
}
impl PreparedReferences {
    fn check_identity(&self, library: &Library) -> Result<()> {
        for source in self.sources.values() { source.check_identity(library)?; }
        Ok(())
    }
}

#[derive(Debug, Default)]
pub(super) struct Engine {
    running: bool,
    stop: Arc<AtomicBool>,
    active: Option<String>,
    active_series_name: Option<String>,
    active_target_name: Option<String>,
    active_target_index: usize,
    active_reconsideration: bool,
    active_cause: Option<String>,
    total: usize,
    compared: usize,
    error: Option<String>,
    config: Option<RuntimeConfig>,
    next_config: Option<RuntimeConfig>,
    prepared_references: Option<Arc<PreparedReferences>>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    running: bool,
    paused: bool,
    pending: i64,
    pending_automatic: i64,
    pending_legacy: i64,
    pending_manual: i64,
    pending_reconsideration: i64,
    completed: i64,
    confirmed: i64,
    active_asset_id: Option<String>,
    active_series_name: Option<String>,
    active_target_name: Option<String>,
    active_target_index: usize,
    active_reconsideration: bool,
    active_cause: Option<String>,
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
            engine.active_series_name = None;
            engine.active_target_name = None;
            engine.active_target_index = 0;
            engine.active_reconsideration = false;
            engine.active_cause = None;
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
        engine.prepared_references = None;
    }
    pub fn character_incremental_status(&self) -> Result<Status> {
        let (running, active, active_series_name, active_target_name, active_target_index, active_reconsideration, active_cause, total, compared, error) = {
            let e = self
                .character_incremental
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            (
                e.running,
                e.active.clone(),
                e.active_series_name.clone(),
                e.active_target_name.clone(),
                e.active_target_index,
                e.active_reconsideration,
                e.active_cause.clone(),
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
        let (pending, pending_automatic, pending_legacy, pending_manual, pending_reconsideration) = c.query_row(
            "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN cause IN ('ingestion','classification','restore','similarity_resolution') THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN cause='legacy' THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN cause='manual_scan' THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN cause='reconsideration' THEN 1 ELSE 0 END),0)
             FROM character_autotag_jobs WHERE state='pending'",
            [],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
        )?;
        Ok(Status {
            running,
            paused,
            pending,
            pending_automatic,
            pending_legacy,
            pending_manual,
            pending_reconsideration,
            completed,
            confirmed,
            active_asset_id: active,
            active_series_name,
            active_target_name,
            active_target_index,
            active_reconsideration,
            active_cause,
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
                    e.active_series_name = None;
                    e.active_target_name = None;
                    e.active_target_index = 0;
                    e.active_reconsideration = job.cause == "reconsideration";
                    e.active_cause = Some(job.cause.clone());
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
                {
                    let mut e = self.character_incremental
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    e.active = None;
                    e.active_series_name = None;
                    e.active_target_name = None;
                    e.active_target_index = 0;
                    e.active_reconsideration = false;
                    e.active_cause = None;
                }
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
        let total_started = Instant::now();
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
        let series_name = {
            let c = self.connection()?;
            active_scope_name(&c, job, &context)?
        };
        {
            let mut e = self.character_incremental.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            e.active_series_name = series_name;
            e.total = context.targets.len();
            e.compared = 0;
        }
        let query_started = Instant::now();
        let query = Source::capture(self, &job.relative_path, &job.content_hash)?;
        let query_capture = query_started.elapsed();
        let reference_started = Instant::now();
        let (prepared, references_reused) = self.prepare_incremental_references(
            prepared_key(&context, &reference_paths, runtime)?, &reference_paths, &stop)?;
        let reference_prepare = reference_started.elapsed();
        let is_reference = reference_paths
            .values()
            .any(|(hash, _)| hash == &job.content_hash);
        let mut worker_prepare = Duration::ZERO;
        let mut cached_compare = Duration::ZERO;
        let predictions=self.character_worker_pool.with(config,&cache,stop.clone(),false,|worker,worker_ready| {
            if worker_ready["runtimeFingerprint"]!=runtime {return Err(Error::Stale);}
            worker.send(&json!({"type":"load_query","assetId":job.asset_id,"hash":job.content_hash,"path":query.path()}))?;
            let loaded=worker.receive()?;
            if loaded["type"]!="query_loaded" || loaded["assetId"]!=job.asset_id || loaded["contentHash"]!=job.content_hash {return Err(Error::Worker("이미지 특징을 불러오지 못했습니다.".into()));}
            let mut predictions=Vec::new();
            for (index, target) in context.targets.iter().enumerate() {
                {
                    let mut e = self.character_incremental.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    e.active_target_name = Some(target.display_name.clone());
                    e.active_target_index = index + 1;
                }
                let refs=target.references.iter().chain(&target.learned_references).map(|r|{
                    let id=r.asset_id.as_ref().ok_or(Error::Stale)?;
                    Ok(json!({"assetId":id,"hash":r.asset_hash,"path":prepared.sources.get(id).ok_or(Error::Stale)?.path()}))
                }).collect::<Result<Vec<_>>>()?;
                let hashes=refs.iter().map(|r|r["hash"].clone()).collect::<Vec<_>>();
                let prepare_started = Instant::now();
                worker.send(&json!({"type":"prepare","references":refs}))?;
                let prepared=worker.receive()?;
                worker_prepare += prepare_started.elapsed();
                if prepared["type"]!="prepared" || prepared["referenceHashes"]!=json!(hashes) {return Err(Error::Worker("기준 이미지 준비 실패".into()));}
                let compare_started = Instant::now();
                worker.send(&json!({"type":"compare_query","assetId":job.asset_id,"hash":job.content_hash}))?;
                let result=worker.receive()?;
                cached_compare += compare_started.elapsed();
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
        let verification_started = Instant::now();
        query.verify(self)?;
        self.check_incremental_references(&prepared)?;
        let source_verification = verification_started.elapsed();
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        if stop.load(Ordering::Acquire) {
            return Err(Error::Stale);
        }
        query.check_identity(self)?;
        self.check_incremental_references(&prepared)?;
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
        self.check_incremental_references(&prepared)?;
        if stop.load(Ordering::Acquire) {
            return Err(Error::Stale);
        }
        tx.commit()?;
        if std::env::var_os("LAKOMICS_CHARACTER_PROFILE").as_deref() == Some(std::ffi::OsStr::new("1")) {
            eprintln!("{}", json!({"characterIncrementalProfile": {
                "assetId": job.asset_id,
                "queryCaptureMs": query_capture.as_secs_f64() * 1000.0,
                "referencePrepareMs": reference_prepare.as_secs_f64() * 1000.0,
                "referencesReused": references_reused,
                "workerPrepareMs": worker_prepare.as_secs_f64() * 1000.0,
                "cachedCompareMs": cached_compare.as_secs_f64() * 1000.0,
                "sourceVerificationMs": source_verification.as_secs_f64() * 1000.0,
                "totalMs": total_started.elapsed().as_secs_f64() * 1000.0
            }}));
        }
        Ok(())
    }
    fn prepare_incremental_references(&self, key: PreparedKey, reference_paths: &BTreeMap<String,(String,String)>, stop: &AtomicBool) -> Result<(Arc<PreparedReferences>,bool)> {
        let cached=self.character_incremental.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .prepared_references.as_ref().filter(|prepared|prepared.key==key).cloned();
        if let Some(prepared)=cached {
            if prepared.check_identity(self).is_ok() { return Ok((prepared,true)); }
            self.invalidate_incremental_references(&prepared);
        }
        let mut sources=BTreeMap::new();
        for (id,(hash,path)) in reference_paths {
            if stop.load(Ordering::Acquire) { return Err(Error::Stale); }
            sources.insert(id.clone(),Arc::new(Source::capture(self,path,hash)?));
        }
        let prepared=Arc::new(PreparedReferences{key,sources});
        self.character_incremental.lock().unwrap_or_else(std::sync::PoisonError::into_inner).prepared_references=Some(prepared.clone());
        Ok((prepared,false))
    }
    fn check_incremental_references(&self, prepared: &Arc<PreparedReferences>) -> Result<()> {
        if let Err(error)=prepared.check_identity(self) {
            self.invalidate_incremental_references(prepared);
            return Err(error);
        }
        Ok(())
    }
    fn invalidate_incremental_references(&self, prepared: &Arc<PreparedReferences>) {
        let mut engine=self.character_incremental.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if engine.prepared_references.as_ref().is_some_and(|current|Arc::ptr_eq(current,prepared)) { engine.prepared_references=None; }
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
        let mut latest = BTreeMap::new();
        for (id, decision, _) in &decisions {
            latest.entry(id).or_insert(decision);
        }
        let blocked = latest
            .iter()
            .filter(|(_, d)| matches!(d.as_str(), "rejected" | "cleared"))
            .map(|(id, _)| id.as_str())
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
fn active_scope_name(
    connection: &rusqlite::Connection,
    job: &Job,
    context: &Context,
) -> Result<Option<String>> {
    let series_ids = context
        .targets
        .iter()
        .filter_map(|target| target.series_classification_id.as_deref())
        .collect::<BTreeSet<_>>();
    if series_ids.len() == 1 {
        let series_id = *series_ids.first().ok_or(Error::Stale)?;
        return Ok(connection
            .query_row(
                "SELECT name FROM classification_entries WHERE id=?1",
                [series_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?);
    }
    if series_ids.is_empty() {
        return Ok(None);
    }
    let scope_name = if job.classification_ids.len() == 1 {
        connection
            .query_row(
                "SELECT name FROM classification_entries WHERE id=?1",
                [&job.classification_ids[0]],
                |row| row.get::<_, String>(0),
            )
            .optional()?
    } else {
        None
    };
    Ok(Some(scope_name.map_or_else(
        || "여러 시리즈".into(),
        |name| format!("{name} · 여러 시리즈"),
    )))
}

fn prepared_key(context:&Context,reference_paths:&BTreeMap<String,(String,String)>,runtime:&str)->Result<PreparedKey>{
    let targets=context.targets.iter().map(|target|{
        let references=target.references.iter().chain(&target.learned_references).map(|reference|{
            let id=reference.asset_id.as_ref().ok_or(Error::Stale)?;
            let (hash,path)=reference_paths.get(id).ok_or(Error::Stale)?;
            if hash!=&reference.asset_hash{return Err(Error::Stale);}
            Ok((id.clone(),hash.clone(),path.clone()))
        }).collect::<Result<Vec<_>>>()?;
        Ok((target.id.clone(),target.fingerprint.clone(),references))
    }).collect::<Result<Vec<_>>>()?;
    Ok(PreparedKey{runtime:runtime.into(),targets})
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
