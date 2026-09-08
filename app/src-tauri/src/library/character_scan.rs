//! Recomputable scan state; human decisions are owned by characters.rs.
use super::{
    character_worker::{RuntimeConfig, Worker, BASELINE},
    characters::{self, Error, Result, Target},
    Library,
};
use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[path = "character_review.rs"]
mod review;
pub use review::{ReviewPage, ReviewQuery};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub id: String,
    pub target_id: String,
    pub target_fingerprint: String,
    pub runtime_fingerprint: Option<String>,
    pub state: String,
    pub total: usize,
    pub completed: usize,
    pub errors: usize,
    pub cache_hits: u64,
    pub extractions: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub asset_id: String,
    pub content_hash: String,
    pub state: String,
    pub evidence: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Default)]
pub(super) struct ScanState {
    status: Option<ScanStatus>,
    cancel: Arc<AtomicBool>,
    results: BTreeMap<String, ScanResult>,
    previous: BTreeMap<String, (ScanStatus, BTreeMap<String, ScanResult>)>,
}

#[derive(Clone)]
struct ScanInput {
    id: String,
    hash: String,
    path: String,
}

impl Library {
    pub fn start_character_scan(
        &self,
        target_id: &str,
        expected_fingerprint: &str,
        config: RuntimeConfig,
    ) -> Result<ScanStatus> {
        let target = self.get_character_target(target_id)?;
        if !target.ready {
            return Err(Error::Invalid(
                "시리즈 안의 기준 이미지 5장을 확인해 주세요.",
            ));
        }
        if target.fingerprint != expected_fingerprint {
            return Err(Error::Stale);
        }
        let mut state = self
            .character_scan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state
            .status
            .as_ref()
            .is_some_and(|s| matches!(s.state.as_str(), "running" | "cancelling"))
        {
            return Err(Error::Invalid("이미 캐릭터 분석이 실행 중입니다."));
        }
        let status = ScanStatus {
            id: uuid::Uuid::new_v4().to_string(),
            target_id: target.id.clone(),
            target_fingerprint: target.fingerprint.clone(),
            runtime_fingerprint: None,
            state: "running".into(),
            total: 0,
            completed: 0,
            errors: 0,
            cache_hits: 0,
            extractions: 0,
            error: None,
        };
        if let Some(previous) = state.status.take() {
            let rows = std::mem::take(&mut state.results);
            state
                .previous
                .insert(previous.target_id.clone(), (previous, rows));
        }
        state.previous.remove(target_id);
        state.cancel = Arc::new(AtomicBool::new(false));
        let cancel = state.cancel.clone();
        state.status = Some(status.clone());
        drop(state);
        let library = self.clone();
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                library.run_character_scan(&target, config, cancel.clone())
            }));
            let mut state = library
                .character_scan
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let status = state.status.as_mut().unwrap();
            if cancel.load(Ordering::Acquire) {
                status.state = "cancelled".into();
            } else {
                match result {
                    Ok(Ok(())) => status.state = "completed".into(),
                    Ok(Err(Error::Stale)) => {
                        status.state = "stale".into();
                        status.error =
                            Some("분석 중 캐릭터 설정이나 기준 이미지가 바뀌었습니다.".into());
                    }
                    Ok(Err(error)) => {
                        status.state = "failed".into();
                        status.error = Some(error.to_string());
                    }
                    Err(_) => {
                        status.state = "failed".into();
                        status.error = Some("캐릭터 분석 작업이 중단되었습니다.".into());
                    }
                }
            }
        });
        Ok(status)
    }

    pub fn character_scan_status(&self) -> Option<ScanStatus> {
        self.character_scan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .status
            .clone()
    }

    pub fn character_scan_runs(&self) -> Vec<ScanStatus> {
        let state = self
            .character_scan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .previous
            .values()
            .map(|(status, _)| status.clone())
            .chain(state.status.clone())
            .collect()
    }

    pub fn cancel_character_scan(&self, id: &str) -> Result<ScanStatus> {
        let mut state = self
            .character_scan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.status.as_ref().is_none_or(|s| s.id != id) {
            return Err(Error::Stale);
        }
        state.cancel.store(true, Ordering::Release);
        let status = state.status.as_mut().unwrap();
        if status.state == "running" {
            status.state = "cancelling".into();
        }
        Ok(status.clone())
    }

    pub(crate) fn stop_character_scan(&self) {
        self.character_scan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .cancel
            .store(true, Ordering::Release);
    }

    pub fn character_scan_results(
        &self,
        id: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ScanResult>> {
        if !(1..=200).contains(&limit) {
            return Err(Error::Invalid("조회 개수가 올바르지 않습니다."));
        }
        let (status, mut rows) = {
            let state = self
                .character_scan
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let (status, results) = state.find(id).ok_or(Error::Stale)?;
            let status = status.clone();
            let rows = results
                .iter()
                .filter(|(key, _)| after.is_none_or(|a| key.as_str() > a))
                .take(limit)
                .map(|(_, row)| row.clone())
                .collect::<Vec<_>>();
            (status, rows)
        };
        let target = self.get_character_target(&status.target_id)?;
        let stale = target.fingerprint != status.target_fingerprint
            || self.reference_inputs(&target).is_err();
        for row in &mut rows {
            let current = self
                .current_input(&target, &row.asset_id)
                .and_then(|input| {
                    if input.hash != row.content_hash {
                        return Err(Error::Stale);
                    }
                    if row.evidence.is_some() {
                        self.verify_input(&input)?;
                    }
                    Ok(())
                });
            if stale || current.is_err() {
                row.state = "stale".into();
                row.evidence = None;
            }
        }
        Ok(rows)
    }

    fn current_input(&self, target: &Target, id: &str) -> Result<ScanInput> {
        let connection = self.connection()?;
        let (hash, path) = characters::scoped_image(
            &connection,
            target
                .series_classification_id
                .as_deref()
                .ok_or(Error::Stale)?,
            id,
        )?;
        Ok(ScanInput {
            id: id.into(),
            hash,
            path,
        })
    }

    fn verify_input(&self, input: &ScanInput) -> Result<()> {
        let mut file = self.open_library_media(&input.path)?.file;
        let mut digest = Sha256::new();
        let mut bytes = [0u8; 65536];
        loop {
            let count = file.read(&mut bytes)?;
            if count == 0 {
                break;
            }
            digest.update(&bytes[..count]);
        }
        let hash: String = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if hash != input.hash {
            return Err(Error::Stale);
        }
        Ok(())
    }

    fn reference_inputs(&self, target: &Target) -> Result<Vec<ScanInput>> {
        if !target.ready {
            return Err(Error::Stale);
        }
        target
            .references
            .iter()
            .map(|reference| {
                let input =
                    self.current_input(target, reference.asset_id.as_deref().ok_or(Error::Stale)?)?;
                if input.hash != reference.asset_hash {
                    return Err(Error::Stale);
                }
                self.verify_input(&input)?;
                Ok(input)
            })
            .collect()
    }

    fn ensure_current_target(&self, target: &Target) -> Result<()> {
        if self.get_character_target(&target.id)?.fingerprint != target.fingerprint {
            return Err(Error::Stale);
        }
        Ok(())
    }

    fn run_character_scan(
        &self,
        target: &Target,
        config: RuntimeConfig,
        cancel: Arc<AtomicBool>,
    ) -> Result<()> {
        let references = self.reference_inputs(target)?;
        let inputs = {
            let connection = self.connection()?;
            let mut statement = connection.prepare("WITH RECURSIVE scope(id) AS (
                SELECT id FROM classification_entries WHERE id=?1 UNION
                SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id)
                SELECT a.id,a.content_hash,a.relative_path FROM assets a
                WHERE a.status='normal' AND a.media_kind='image'
                AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope))
                AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.target_id=?2 AND r.asset_id=a.id) ORDER BY a.id")?;
            let rows = statement
                .query_map(params![target.series_classification_id, target.id], |r| {
                    Ok(ScanInput {
                        id: r.get(0)?,
                        hash: r.get(1)?,
                        path: r.get(2)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        {
            let mut state = self
                .character_scan
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.status.as_mut().unwrap().total = inputs.len();
            for input in &inputs {
                state.results.insert(
                    input.id.clone(),
                    ScanResult {
                        asset_id: input.id.clone(),
                        content_hash: input.hash.clone(),
                        state: "pending".into(),
                        evidence: None,
                        error: None,
                    },
                );
            }
        }
        let mut worker = Worker::start(
            &config,
            &self.root.join(".cache/characters"),
            cancel.clone(),
        )?;
        let ready = worker.receive()?;
        if ready["type"] != "ready" || ready["baselineFingerprint"] != BASELINE {
            return Err(worker_error(&ready));
        }
        let runtime = ready["runtimeFingerprint"]
            .as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| worker_error(&ready))?;
        self.character_scan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .status
            .as_mut()
            .unwrap()
            .runtime_fingerprint = Some(runtime.into());
        let refs = references
            .iter()
            .map(|input| self.wire_input(input))
            .collect::<Result<Vec<_>>>()?;
        worker.send(&json!({"type":"prepare", "references":refs}))?;
        let prepared = worker.receive()?;
        let hashes: Vec<_> = references.iter().map(|r| r.hash.as_str()).collect();
        if prepared["type"] != "prepared" || prepared["referenceHashes"] != json!(hashes) {
            return Err(worker_error(&prepared));
        }
        self.update_scan_counters(&prepared);
        for input in inputs {
            if cancel.load(Ordering::Acquire) {
                return Err(Error::Worker("취소됨".into()));
            }
            self.ensure_current_target(target)?;
            let current = self.current_input(target, &input.id);
            let event = match current {
                Ok(current) if current.hash == input.hash => match self.wire_input(&current) {
                    Ok(mut request) => {
                        request["type"] = json!("query");
                        worker.send(&request)?;
                        let event = worker.receive()?;
                        if event["assetId"] != input.id
                            || (event["type"] != "result" && event["type"] != "asset_error")
                        {
                            return Err(worker_error(&event));
                        }
                        event
                    }
                    Err(error) => json!({"type":"asset_error", "error":error.to_string()}),
                },
                _ => json!({"type":"asset_error", "error":"자산이 이동되거나 변경되었습니다."}),
            };
            self.ensure_current_target(target)?;
            let mut row = ScanResult {
                asset_id: input.id.clone(),
                content_hash: input.hash.clone(),
                state: "error".into(),
                evidence: None,
                error: None,
            };
            if event["type"] == "result" {
                if event["contentHash"] != input.hash
                    || event["referenceHashes"] != json!(hashes)
                    || event["baselineFingerprint"] != BASELINE
                    || !event["passed"].is_boolean()
                    || !event["distance"].as_f64().is_some_and(|d| d.is_finite())
                {
                    return Err(worker_error(&event));
                }
                match self.current_input(target, &input.id).and_then(|current| {
                    if current.hash != input.hash {
                        return Err(Error::Stale);
                    }
                    self.verify_input(&current)
                }) {
                    Ok(()) => {
                        row.state = if event["passed"] == true {
                            "recommended"
                        } else {
                            "unmatched"
                        }
                        .into();
                        row.evidence = Some(event.clone());
                        row.evidence.as_mut().unwrap()["runtimeFingerprint"] = json!(runtime);
                    }
                    Err(_) => row.state = "stale".into(),
                }
            } else {
                row.error = Some(event["error"].as_str().unwrap_or("이미지 분석 실패").into());
            }
            self.update_scan_counters(&event);
            let mut state = self
                .character_scan
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let status = state.status.as_mut().unwrap();
            status.completed += 1;
            if row.state == "error" {
                status.errors += 1;
            }
            state.results.insert(input.id, row);
        }
        self.ensure_current_target(target)?;
        self.reference_inputs(target)?;
        Ok(())
    }

    fn wire_input(&self, input: &ScanInput) -> Result<Value> {
        self.open_library_media(&input.path)?;
        let path = std::fs::canonicalize(self.root.join(&input.path))?;
        if !path.starts_with(std::fs::canonicalize(&self.root)?) {
            return Err(Error::Invalid("라이브러리 밖의 이미지입니다."));
        }
        Ok(json!({"assetId":input.id, "path":path, "hash":input.hash}))
    }

    fn update_scan_counters(&self, event: &Value) {
        let mut state = self
            .character_scan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let status = state.status.as_mut().unwrap();
        if let Some(hits) = event["cacheHits"].as_u64() {
            status.cache_hits = hits;
        }
        if let Some(misses) = event["extractions"].as_u64() {
            status.extractions = misses;
        }
    }
}

impl ScanState {
    fn find(&self, id: &str) -> Option<(&ScanStatus, &BTreeMap<String, ScanResult>)> {
        self.status
            .as_ref()
            .filter(|s| s.id == id)
            .map(|s| (s, &self.results))
            .or_else(|| {
                self.previous
                    .values()
                    .find(|(s, _)| s.id == id)
                    .map(|(s, r)| (s, r))
            })
    }
}

impl Library {
    pub(super) fn checked_character_evidence(
        &self,
        connection: &rusqlite::Connection,
        target: &Target,
        request: &characters::DecisionRequest,
    ) -> Result<BTreeMap<String, Value>> {
        let id = request.scan_id.as_deref().ok_or(Error::Stale)?;
        let (status, rows) = {
            let state = self
                .character_scan
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let (status, rows) = state.find(id).ok_or(Error::Stale)?;
            (
                status.clone(),
                request
                    .asset_ids
                    .iter()
                    .map(|id| rows.get(id).cloned().ok_or(Error::Stale))
                    .collect::<Result<Vec<_>>>()?,
            )
        };
        if status.target_id != target.id
            || status.target_fingerprint != target.fingerprint
            || status.runtime_fingerprint != request.baseline_fingerprint
            || !target.ready
        {
            return Err(Error::Stale);
        }
        let series = target
            .series_classification_id
            .as_deref()
            .ok_or(Error::Stale)?;
        for reference in &target.references {
            let id = reference.asset_id.as_deref().ok_or(Error::Stale)?;
            let (hash, path) = characters::scoped_image(connection, series, id)?;
            if hash != reference.asset_hash {
                return Err(Error::Stale);
            }
            self.verify_input(&ScanInput {
                id: id.into(),
                hash,
                path,
            })?;
        }
        rows.into_iter().map(|row| {
            if !matches!(row.state.as_str(), "recommended" | "unmatched") { return Err(Error::Stale); }
            let (hash,path) = characters::scoped_image(connection,series,&row.asset_id)?;
            if hash != row.content_hash { return Err(Error::Stale); }
            self.verify_input(&ScanInput {id:row.asset_id.clone(),hash,path})?;
            let evidence = row.evidence.ok_or(Error::Stale)?;
            Ok((row.asset_id, json!({"scanId":id,"runtimeFingerprint":status.runtime_fingerprint,"prediction":evidence,"references":target.references})))
        }).collect()
    }
}

fn worker_error(event: &Value) -> Error {
    Error::Worker(
        event["error"]
            .as_str()
            .unwrap_or("캐릭터 worker 프로토콜 또는 baseline 불일치")
            .into(),
    )
}

#[cfg(test)]
#[path = "character_scan_tests.rs"]
mod tests;
