//! Native queue consumer. One complete asset result is the publication unit.
#[cfg(test)]
use super::character_autotag;
use super::{
    character_autotag::{Context, Job, Prediction, ReviewState},
    character_scan::{same_person, ScanResult},
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
    io::Write,
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
        for source in self.sources.values() {
            source.check_identity(library)?;
        }
        Ok(())
    }
}

type TrainingSources = BTreeMap<String, Arc<Source>>;

#[derive(Debug)]
struct AugmentationTraining {
    context: Context,
    snapshot_id: String,
    body: Value,
    paths: BTreeMap<String, (String, String)>,
    sources: Arc<TrainingSources>,
    bytes: u64,
    ready: bool,
}

fn training_file(mut body: Value, sources: &TrainingSources) -> Result<tempfile::NamedTempFile> {
    body["policy"] = super::character_augmentation::policy();
    for asset in body["assets"].as_array_mut().ok_or(Error::Stale)? {
        let id = asset["id"].as_str().ok_or(Error::Stale)?;
        asset["path"] = json!(sources.get(id).ok_or(Error::Stale)?.path());
    }
    let mut file = tempfile::NamedTempFile::new()?;
    file.write_all(&serde_json::to_vec(&body)?)?;
    file.flush()?;
    Ok(file)
}

struct AugmentationResult {
    snapshot_id: String,
    sources: Arc<TrainingSources>,
    query_identity: Value,
    response: Value,
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
    training: Option<AugmentationTraining>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWork {
    active: bool,
    series_name: Option<String>,
    target_name: Option<String>,
    cause: Option<String>,
    fresh_remaining: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    running: bool,
    work_active: bool,
    automation_enabled: bool,
    paused: bool,
    completed: i64,
    confirmed: i64,
    history_refresh_active: bool,
    active_work: ActiveWork,
    history_refreshes: Vec<super::character_reference_refresh::ReferenceRefreshProgress>,
    persistent_error: Option<String>,
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
        if engine.config.as_ref() != Some(&config) {
            engine.training = None;
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
        engine.training = None;
    }
    pub fn character_incremental_status(&self) -> Result<Status> {
        let (running, work_active, persistent_error, mut active_work) = {
            let e = self
                .character_incremental
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            (
                e.running,
                e.active.is_some(),
                e.error.clone(),
                ActiveWork {
                    active: e.active.is_some(),
                    series_name: e.active_series_name.clone(),
                    target_name: e.active_target_name.clone(),
                    cause: e.active_cause.clone(),
                    fresh_remaining: 0,
                },
            )
        };
        let c = self.connection()?;
        let (paused, completed, confirmed, pending, history_refresh_active, automation_enabled) = c.query_row(
            "SELECT reference_refresh_paused,completed,confirmed,
                EXISTS(SELECT 1 FROM character_autotag_jobs WHERE state='pending'),
                EXISTS(SELECT 1 FROM character_reference_refreshes WHERE state IN ('pending','running')),
                NOT paused
             FROM character_autotag_control WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, bool>(3)?, r.get(4)?, r.get(5)?)),
        )?;
        active_work.fresh_remaining = c
            .query_row(
                "SELECT COUNT(*) FROM character_autotag_jobs
            WHERE state IN ('pending','processing') AND cause<>'reconsideration'",
                [],
                |r| r.get::<_, i64>(0),
            )?
            .max(0) as usize;
        let history_refreshes = super::character_reference_refresh::refresh_progress(&c)?;
        Ok(Status {
            running,
            work_active: work_active || pending,
            automation_enabled,
            paused,
            completed,
            confirmed,
            history_refresh_active,
            active_work,
            history_refreshes,
            persistent_error,
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
                let worker_paused: bool = self.connection()?.query_row(
                    "SELECT paused FROM character_autotag_control WHERE singleton=1",
                    [],
                    |row| row.get(0),
                )?;
                if worker_paused {
                    return Ok(false);
                }
                let Some(job) = self.claim_character_autotag()? else {
                    if self.advance_character_reference_refresh(32)? > 0 {
                        return Ok(true);
                    }
                    // Optional preparation never delays a queued native result.
                    return Ok(self
                        .advance_character_augmentation(&config, stop.clone())
                        .unwrap_or(false));
                };
                if self.supersede_invalid_reference_refresh_job(&job)? {
                    return Ok(true);
                }
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
                    let error_text = error.to_string();
                    let c = self.connection()?;
                    // The claim token also fences restore/library-switch races.
                    c.execute("UPDATE character_autotag_jobs SET state=?3,claim_id=NULL,error=?4,review_state=?5,retry_at=?6
                        WHERE asset_id=?1 AND claim_id=?2",params![job.asset_id,job.claim_id,if retry{"pending"}else{"failed"},error_text,
                        if retry{"unresolved"}else{"failed"},chrono::Utc::now().timestamp()+if stopped{0}else{job.attempts*2}])?;
                    drop(c);
                    if !retry {
                        self.fail_reference_refresh_item(&job, &error_text)?;
                    }
                }
                {
                    let mut e = self
                        .character_incremental
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
            self.complete_reference_refresh_item(&tx, job, &BTreeSet::new(), false, true)?;
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
                for reference in target
                    .usable_references()
                {
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
            let mut e = self
                .character_incremental
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            e.active_series_name = series_name;
            e.total = context.targets.len();
            e.compared = 0;
        }
        let query_started = Instant::now();
        let query = Source::capture(self, &job.relative_path, &job.content_hash)?;
        let query_capture = query_started.elapsed();
        let reference_started = Instant::now();
        let (prepared, references_reused) = self.prepare_incremental_references(
            prepared_key(&context, &reference_paths, runtime)?,
            &reference_paths,
            &stop,
        )?;
        let reference_prepare = reference_started.elapsed();
        let reference_targets = context
            .targets
            .iter()
            .filter(|target| {
                target
                    .usable_references()
                    .any(|reference| reference.asset_hash == job.content_hash)
            })
            .map(|target| target.id.clone())
            .collect::<BTreeSet<_>>();
        let refresh_reuse = {
            let connection = self.connection()?;
            let mut values = BTreeMap::new();
            for target in &context.targets {
                let hashes = target
                    .usable_references()
                    .map(|reference| reference.asset_hash.clone())
                    .collect::<Vec<_>>();
                if let Some(evidence) = self.reference_refresh_evidence_reuse(
                    &connection,
                    job,
                    target,
                    runtime,
                    &hashes,
                )? {
                    values.insert(target.id.clone(), evidence);
                }
            }
            values
        };
        let mut worker_prepare = Duration::ZERO;
        let mut cached_compare = Duration::ZERO;
        let (predictions, refresh_delta_targets)=self.character_worker_pool.with(config,&cache,stop.clone(),false,|worker,worker_ready| {
            if worker_ready["runtimeFingerprint"]!=runtime {return Err(Error::Stale);}
            worker.send(&json!({"type":"load_query","assetId":job.asset_id,"hash":job.content_hash,"path":query.path()}))?;
            let loaded=worker.receive()?;
            if loaded["type"]!="query_loaded" || loaded["assetId"]!=job.asset_id || loaded["contentHash"]!=job.content_hash {return Err(Error::Worker("이미지 특징을 불러오지 못했습니다.".into()));}
            let mut predictions=Vec::new();
            let mut refresh_delta_targets=BTreeSet::new();
            for (index, target) in context.targets.iter().enumerate() {
                {
                    let mut e = self.character_incremental.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    e.active_target_name = Some(target.display_name.clone());
                    e.active_target_index = index + 1;
                }
                let refs=target.usable_references().map(|r|{
                    let id=r.asset_id.as_ref().ok_or(Error::Stale)?;
                    Ok(json!({"assetId":id,"hash":r.asset_hash,"region":r.region,"path":prepared.sources.get(id).ok_or(Error::Stale)?.path()}))
                }).collect::<Result<Vec<_>>>()?;
                let hashes=refs.iter().map(|r|r["hash"].as_str().map(str::to_owned).ok_or(Error::Stale)).collect::<Result<Vec<_>>>()?;
                let compare_started = Instant::now();
                let result = if let Some(reuse) = refresh_reuse.get(&target.id) {
                    match reuse {
                        super::character_reference_refresh::ReferenceRefreshEvidenceReuse::Exact(old) => old.clone(),
                        super::character_reference_refresh::ReferenceRefreshEvidenceReuse::Delta(old) => {
                            let old_count = old["referenceHashes"].as_array().map_or(0, Vec::len);
                            if old_count >= refs.len() {
                                return Err(Error::Stale);
                            }
                            match worker.compare_delta(&job.asset_id, &job.content_hash, old, &refs[old_count..]) {
                                Ok(result) => {
                                    refresh_delta_targets.insert(target.id.clone());
                                    result
                                }
                                Err(_) => {
                                    let prepare_started = Instant::now();
                                    worker.send(&json!({"type":"prepare","references":refs}))?;
                                    let prepared=worker.receive()?;
                                    worker_prepare += prepare_started.elapsed();
                                    if prepared["type"]!="prepared" || prepared["referenceHashes"]!=json!(hashes) {return Err(Error::Worker("기준 이미지 준비 실패".into()));}
                                    worker.send(&json!({"type":"compare_query","assetId":job.asset_id,"hash":job.content_hash}))?;
                                    worker.receive()?
                                }
                            }
                        }
                    }
                } else {
                    let prepare_started = Instant::now();
                    worker.send(&json!({"type":"prepare","references":refs}))?;
                    let prepared=worker.receive()?;
                    worker_prepare += prepare_started.elapsed();
                    if prepared["type"]!="prepared" || prepared["referenceHashes"]!=json!(hashes) {return Err(Error::Worker("기준 이미지 준비 실패".into()));}
                    worker.send(&json!({"type":"compare_query","assetId":job.asset_id,"hash":job.content_hash}))?;
                    worker.receive()?
                };
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
            Ok((predictions, refresh_delta_targets))
        })?;
        // Borrow separately: an optional worker failure resets the child but
        // cannot discard the already completed native comparisons.
        let augmentation =
            if config.augmentation_model.is_some() && ready["augmentationAvailable"] == true {
                self.compare_character_augmentation(
                    job,
                    config,
                    stop.clone(),
                    &context,
                    &query,
                    &predictions,
                    &reference_targets,
                )
                .ok()
                .flatten()
            } else {
                None
            };
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
        let extra = augmentation.as_ref().filter(|a| {
            self.character_training_snapshot(&tx, &context)
                .is_ok_and(|s| s.id == a.snapshot_id)
                && super::character_training::query_identity(&tx, &job.asset_id)
                    .is_ok_and(|identity| identity == a.query_identity)
                && a.sources
                    .values()
                    .all(|source| source.check_identity(self).is_ok())
        });
        self.finalize_incremental_augmented(
            &tx,
            job,
            &context,
            &predictions,
            &reference_targets,
            &refresh_delta_targets,
            extra.map(|a| &a.response),
        )?;
        if let Some(a) = extra {
            for source in a.sources.values() {
                source.check_identity(self)?;
            }
        }
        query.check_identity(self)?;
        self.check_incremental_references(&prepared)?;
        if stop.load(Ordering::Acquire) {
            return Err(Error::Stale);
        }
        tx.commit()?;
        if std::env::var_os("LAKOMICS_CHARACTER_PROFILE").as_deref()
            == Some(std::ffi::OsStr::new("1"))
        {
            eprintln!(
                "{}",
                json!({"characterIncrementalProfile": {
                    "assetId": job.asset_id,
                    "queryCaptureMs": query_capture.as_secs_f64() * 1000.0,
                    "referencePrepareMs": reference_prepare.as_secs_f64() * 1000.0,
                    "referencesReused": references_reused,
                    "workerPrepareMs": worker_prepare.as_secs_f64() * 1000.0,
                    "cachedCompareMs": cached_compare.as_secs_f64() * 1000.0,
                    "sourceVerificationMs": source_verification.as_secs_f64() * 1000.0,
                    "totalMs": total_started.elapsed().as_secs_f64() * 1000.0
                }})
            );
        }
        Ok(())
    }
    fn compare_character_augmentation(
        &self,
        job: &Job,
        config: &RuntimeConfig,
        stop: Arc<AtomicBool>,
        context: &Context,
        query: &Source,
        predictions: &[Prediction],
        reference_targets: &BTreeSet<String>,
    ) -> Result<Option<AugmentationResult>> {
        let (snapshot, query_identity, prior) = {
            let mut c = self.connection()?;
            let tx = c.transaction()?;
            let identity = super::character_training::query_identity(&tx, &job.asset_id)?;

            let mut prior = BTreeMap::new();
            let rows = tx.prepare("SELECT target_id,decision FROM character_decisions WHERE source_asset_id=?1 ORDER BY sequence DESC")?
                .query_map([&job.asset_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?
                .collect::<std::result::Result<Vec<_>,_>>()?;
            for (target, decision) in rows {
                prior.entry(target).or_insert(decision);
            }
            let snapshot = self.character_training_snapshot(&tx, context)?;
            (snapshot, identity, prior)
        };
        let (native, _) =
            super::character_augmentation::native_selection(predictions, &prior, reference_targets);
        let native_ids = native
            .iter()
            .map(|p| p.target_id.clone())
            .chain(
                prior
                    .iter()
                    .filter(|(_, decision)| decision.as_str() == "accepted")
                    .map(|(id, _)| id.clone()),
            )
            .collect::<BTreeSet<_>>();
        if !predictions.iter().any(|p| {
            !native_ids.contains(&p.target_id)
                && !prior.contains_key(&p.target_id)
                && !reference_targets.contains(&p.target_id)
                && p.result
                    .evidence
                    .as_ref()
                    .is_some_and(|e| e["wholeFallback"] == false)
        }) {
            return Ok(None);
        }
        if stop.load(Ordering::Acquire) {
            return Err(Error::Stale);
        }
        let sources = {
            let mut engine = self
                .character_incremental
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if engine
                .training
                .as_ref()
                .is_none_or(|training| training.snapshot_id != snapshot.id)
            {
                engine.training = Some(AugmentationTraining {
                    context: Context {
                        hash: context.hash.clone(),
                        runtime: context.runtime.clone(),
                        scope: context.scope.clone(),
                        targets: context.targets.clone(),
                    },
                    snapshot_id: snapshot.id.clone(),
                    body: snapshot.value.clone(),
                    paths: snapshot.sources,
                    sources: Arc::new(BTreeMap::new()),
                    bytes: 0,
                    ready: false,
                });
            }
            let training = engine.training.as_ref().ok_or(Error::Stale)?;
            if !training.ready {
                return Ok(None);
            }
            training.sources.clone()
        };
        for source in sources.values() {
            if let Err(error) = source.check_identity(self) {
                self.character_incremental
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .training = None;
                return Err(error);
            }
        }
        let Some(worker_identity) =
            super::character_augmentation::query_identity(&query_identity, query)?
        else {
            return Ok(None);
        };
        query.check_identity(self)?;
        if stop.load(Ordering::Acquire) {
            return Err(Error::Stale);
        }
        let file = training_file(snapshot.value, &sources)?;
        let cache = self.root.join(".cache/characters");
        let result = self.character_worker_pool.with(config, &cache, stop, false, |worker, ready| {
            if ready["runtimeFingerprint"] != context.runtime || ready["augmentationAvailable"] != true { return Ok(None); }
            worker.send(&json!({"type":"augmentation_prepare","snapshotId":snapshot.id,"snapshotPath":file.path()}))?;
            let response = worker.receive()?;
            if response["type"] != "augmentation_prepared" || response["snapshotId"] != snapshot.id { return Err(Error::Stale); }
            if response["state"] == "building" {
                // A worker restart lost the head, not the native result. Rebuild only when idle.
                if let Some(training) = self.character_incremental.lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner).training.as_mut()
                    .filter(|training| training.snapshot_id == snapshot.id) {
                    training.ready = false;
                }
                return Ok(None);
            }
            if response["state"] != "ready" || !super::character_augmentation::is_hash(&response["modelId"]) { return Err(Error::Stale); }
            let model_id = response["modelId"].clone();
            // The pool may have serviced a manual request since native comparison.
            worker.send(&json!({"type":"load_query","assetId":job.asset_id,"hash":job.content_hash,"path":query.path()}))?;
            let loaded = worker.receive()?;
            if loaded["type"] != "query_loaded" || loaded["assetId"] != job.asset_id || loaded["contentHash"] != job.content_hash { return Err(Error::Stale); }
            let bundle = predictions.iter().map(|p| (p.target_id.clone(), p.result.evidence.clone().unwrap_or(Value::Null))).collect::<BTreeMap<_,_>>();
            worker.send(&json!({"type":"augment_query","snapshotId":snapshot.id,"assetId":job.asset_id,"hash":job.content_hash,"path":query.path(),
                "queryIdentity":worker_identity,"nativeAccepted":native_ids,"bundle":bundle}))?;
            let response = worker.receive()?;
            if response["type"] != "augmentation_result" || response["snapshotId"] != snapshot.id || response["modelId"] != model_id { return Err(Error::Stale); }
            Ok((response["state"] == "ready").then_some(response))
        })?;
        for source in sources.values() {
            source.check_identity(self)?;
        }
        Ok(result.map(|response| AugmentationResult {
            snapshot_id: snapshot.id,
            sources,
            query_identity,
            response,
        }))
    }

    fn augmentation_idle_allowed(&self, stop: &AtomicBool) -> Result<bool> {
        if stop.load(Ordering::Acquire) {
            return Ok(false);
        }
        Ok(self.connection()?.query_row(
            "SELECT NOT paused AND NOT reference_refresh_paused
                AND NOT EXISTS(SELECT 1 FROM character_autotag_jobs WHERE state IN ('pending','processing'))
                AND NOT EXISTS(SELECT 1 FROM character_reference_refreshes WHERE state IN ('pending','running'))
             FROM character_autotag_control WHERE singleton=1", [], |row| row.get(0),
        )?)
    }

    /// One source capture or extraction per idle turn; no second worker or history requeue.
    fn advance_character_augmentation(
        &self,
        config: &RuntimeConfig,
        stop: Arc<AtomicBool>,
    ) -> Result<bool> {
        if config.augmentation_model.is_none() || !self.augmentation_idle_allowed(&stop)? {
            return Ok(false);
        }
        let mut training = {
            let mut engine = self
                .character_incremental
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if engine
                .training
                .as_ref()
                .is_none_or(|training| training.ready)
            {
                return Ok(false);
            }
            engine.training.take().ok_or(Error::Stale)?
        };
        // Invalid or failed optional preparation is dropped; a later eligible query can retry.
        let snapshot = {
            let mut connection = self.connection()?;
            let transaction = connection.transaction()?;
            self.character_training_snapshot(&transaction, &training.context)?
        };
        if snapshot.id != training.snapshot_id {
            return Ok(false);
        }
        let progressed = if let Some((id, (hash, path))) = training
            .paths
            .iter()
            .find(|(id, _)| !training.sources.contains_key(*id))
        {
            if !self.augmentation_idle_allowed(&stop)? {
                false
            } else {
                training.bytes = training
                    .bytes
                    .saturating_add(self.open_library_media(path)?.file.metadata()?.len());
                if training.bytes > 512 * 1024 * 1024 {
                    return Err(Error::Invalid("보완 학습 이미지 용량 한도를 넘었습니다."));
                }
                let source = Arc::new(Source::capture(self, path, hash)?);
                Arc::make_mut(&mut training.sources).insert(id.clone(), source);
                true
            }
        } else {
            for source in training.sources.values() {
                source.check_identity(self)?;
            }
            let file = training_file(training.body.clone(), &training.sources)?;
            let cache = self.root.join(".cache/characters");
            self.character_worker_pool.with(config, &cache, stop.clone(), false, |worker, ready| {
                // Recheck after waiting for a manual request to release the shared worker.
                if !self.augmentation_idle_allowed(&stop)? { return Ok(false); }
                if ready["runtimeFingerprint"] != training.context.runtime || ready["augmentationAvailable"] != true {
                    return Err(Error::Stale);
                }
                worker.send(&json!({"type":"augmentation_prepare","snapshotId":training.snapshot_id,"snapshotPath":file.path()}))?;
                let mut response = worker.receive()?;
                if response["type"] != "augmentation_prepared" || response["snapshotId"] != training.snapshot_id {
                    return Err(Error::Stale);
                }
                if response["state"] == "building" && self.augmentation_idle_allowed(&stop)? {
                    worker.send(&json!({"type":"augmentation_step","snapshotId":training.snapshot_id}))?;
                    response = worker.receive()?;
                }
                if response["type"] != "augmentation_prepared" || response["snapshotId"] != training.snapshot_id {
                    return Err(Error::Stale);
                }
                if response["state"] == "ready" && super::character_augmentation::is_hash(&response["modelId"]) {
                    training.ready = true;
                } else if response["state"] != "building" {
                    return Err(Error::Stale);
                }
                Ok(true)
            })?
        };
        if !stop.load(Ordering::Acquire) {
            self.character_incremental
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .training = Some(training);
        }
        Ok(progressed)
    }

    fn prepare_incremental_references(
        &self,
        key: PreparedKey,
        reference_paths: &BTreeMap<String, (String, String)>,
        stop: &AtomicBool,
    ) -> Result<(Arc<PreparedReferences>, bool)> {
        let cached = self
            .character_incremental
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .prepared_references
            .as_ref()
            .filter(|prepared| prepared.key == key)
            .cloned();
        if let Some(prepared) = cached {
            if prepared.check_identity(self).is_ok() {
                return Ok((prepared, true));
            }
            self.invalidate_incremental_references(&prepared);
        }
        let mut sources = BTreeMap::new();
        for (id, (hash, path)) in reference_paths {
            if stop.load(Ordering::Acquire) {
                return Err(Error::Stale);
            }
            sources.insert(id.clone(), Arc::new(Source::capture(self, path, hash)?));
        }
        let prepared = Arc::new(PreparedReferences { key, sources });
        self.character_incremental
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .prepared_references = Some(prepared.clone());
        Ok((prepared, false))
    }
    fn check_incremental_references(&self, prepared: &Arc<PreparedReferences>) -> Result<()> {
        if let Err(error) = prepared.check_identity(self) {
            self.invalidate_incremental_references(prepared);
            return Err(error);
        }
        Ok(())
    }
    fn invalidate_incremental_references(&self, prepared: &Arc<PreparedReferences>) {
        let mut engine = self
            .character_incremental
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if engine
            .prepared_references
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, prepared))
        {
            engine.prepared_references = None;
        }
    }
    #[cfg(test)]
    fn finalize_incremental(
        &self,
        tx: &rusqlite::Transaction<'_>,
        job: &Job,
        context: &Context,
        predictions: &[Prediction],
        reference_targets: &BTreeSet<String>,
        refresh_delta_targets: &BTreeSet<String>,
    ) -> Result<()> {
        self.finalize_incremental_augmented(
            tx,
            job,
            context,
            predictions,
            reference_targets,
            refresh_delta_targets,
            None,
        )
    }

    fn finalize_incremental_augmented(
        &self,
        tx: &rusqlite::Transaction<'_>,
        job: &Job,
        context: &Context,
        predictions: &[Prediction],
        reference_targets: &BTreeSet<String>,
        refresh_delta_targets: &BTreeSet<String>,
        augmentation: Option<&Value>,
    ) -> Result<()> {
        let decisions=tx.prepare("SELECT target_id,decision,origin FROM character_decisions WHERE source_asset_id=?1 ORDER BY sequence DESC")?
            .query_map([&job.asset_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut latest = BTreeMap::new();
        for (id, decision, _) in &decisions {
            latest.entry(id.clone()).or_insert(decision.clone());
        }
        let (mut accepted, mut covered) = super::character_augmentation::native_selection(
            predictions,
            &latest,
            reference_targets,
        );
        let boxes = predictions
            .first()
            .and_then(|p| p.result.evidence.as_ref())
            .and_then(|e| e["queryBoxes"].as_array())
            .cloned()
            .unwrap_or_default();
        let known = !reference_targets.is_empty()
            || latest
                .values()
                .any(|decision| decision.as_str() == "accepted");
        let native_ids = accepted
            .iter()
            .map(|p| p.target_id.clone())
            .chain(
                latest
                    .iter()
                    .filter(|(_, decision)| decision.as_str() == "accepted")
                    .map(|(id, _)| id.clone()),
            )
            .collect::<BTreeSet<_>>();
        let additions = augmentation
            .and_then(|response| {
                super::character_augmentation::additions(
                    response,
                    predictions,
                    &native_ids,
                    &latest,
                    reference_targets,
                )
            })
            .unwrap_or_default();
        for p in predictions {
            if let Some(regions) = additions.get(&p.target_id) {
                covered.extend(regions);
                accepted.push(p);
            }
        }
        let unresolved = boxes
            .iter()
            .filter(|b| box_array(b).is_none_or(|r| !covered.iter().any(|c| same_person(&r, c))))
            .cloned()
            .collect::<Vec<_>>();
        let resolved = (known && boxes.len() == 1) || (!boxes.is_empty() && unresolved.is_empty());
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
            evidence["learnedReferences"] =
                json!(target.usable_learned_references().collect::<Vec<_>>());
            evidence["automaticScope"] = json!(true);
            if additions.contains_key(&p.target_id) {
                evidence["augmentation"] = augmentation.cloned().unwrap_or(Value::Null);
            }
            let snapshot = json!({"scanId":evidence_id,"runtimeFingerprint":context.runtime,"prediction":evidence,"references":target.usable_references().collect::<Vec<_>>()});
            tx.execute("INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,baseline_fingerprint,reference_snapshot,origin,created_at)
                VALUES(?1,?2,?2,?3,'accepted',?4,?5,?6,'automatic',?7)",params![target.id,job.asset_id,job.content_hash,target.fingerprint,context.runtime,serde_json::to_string(&snapshot)?,chrono::Utc::now().to_rfc3339()])?;
        }
        // Inference adds character membership, never changes the user's saved folder.
        self.complete_reference_refresh_item(tx, job, refresh_delta_targets, true, true)?;
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

fn prepared_key(
    context: &Context,
    reference_paths: &BTreeMap<String, (String, String)>,
    runtime: &str,
) -> Result<PreparedKey> {
    let targets = context
        .targets
        .iter()
        .map(|target| {
            let references = target
                .usable_references()
                .map(|reference| {
                    let id = reference.asset_id.as_ref().ok_or(Error::Stale)?;
                    let (hash, path) = reference_paths.get(id).ok_or(Error::Stale)?;
                    if hash != &reference.asset_hash {
                        return Err(Error::Stale);
                    }
                    Ok((id.clone(), hash.clone(), path.clone()))
                })
                .collect::<Result<Vec<_>>>()?;
            Ok((target.id.clone(), target.fingerprint.clone(), references))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(PreparedKey {
        runtime: runtime.into(),
        targets,
    })
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
