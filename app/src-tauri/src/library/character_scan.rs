//! Recomputable scan state; human decisions are owned by characters.rs.
use super::{
    character_worker::{RuntimeConfig, Worker, BASELINE},
    characters::{self, Error, Result, Target},
    Library,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
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
#[path = "character_comparisons.rs"]
mod comparisons;
use comparisons::Comparisons;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub automatic: bool,
    pub id: String,
    pub target_id: String,
    pub target_fingerprint: String,
    pub runtime_fingerprint: Option<String>,
    pub state: String,
    pub total: usize,
    pub completed: usize,
    pub errors: usize,
    pub reused: usize,
    pub cache_hits: u64,
    pub extractions: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
        self.start_character_scan_mode(target_id, expected_fingerprint, config, false)
    }

    pub fn start_character_scan_mode(
        &self, target_id: &str, expected_fingerprint: &str, config: RuntimeConfig, automatic: bool,
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
            automatic,
            id: uuid::Uuid::new_v4().to_string(),
            target_id: target.id.clone(),
            target_fingerprint: target.fingerprint.clone(),
            runtime_fingerprint: None,
            state: "running".into(),
            total: 0,
            completed: 0,
            errors: 0,
            reused: 0,
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
                library.run_character_scan(&target, config, cancel.clone(), automatic)
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
                .current_input_mode(&target, &row.asset_id, status.automatic)
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
        self.current_input_mode(target, id, false)
    }

    fn current_input_mode(&self, target: &Target, id: &str, automatic: bool) -> Result<ScanInput> {
        let connection = self.connection()?;
        let (hash, path) = super::character_hub::candidate_image_mode(
            &connection,
            target
                .series_classification_id
                .as_deref()
                .ok_or(Error::Stale)?,
            id, automatic,
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
            .chain(target.learned_references.iter())
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
        let current = self.get_character_target(&target.id)?;
        if current.fingerprint != target.fingerprint || current.learned_references.iter().map(|r| (&r.asset_id,&r.asset_hash)).collect::<Vec<_>>() != target.learned_references.iter().map(|r| (&r.asset_id,&r.asset_hash)).collect::<Vec<_>>() {
            return Err(Error::Stale);
        }
        Ok(())
    }

    #[cfg(test)]
    fn character_scan_inputs(&self, target: &Target) -> Result<Vec<ScanInput>> {
        self.character_scan_inputs_mode(target, false)
    }

    fn character_scan_inputs_mode(&self, target: &Target, automatic: bool) -> Result<Vec<ScanInput>> {
        let inputs = {
            let connection = self.connection()?;
            let mut statement = connection.prepare("WITH RECURSIVE scope(id) AS (
                SELECT id FROM classification_entries WHERE id=?1 UNION
                SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id),
                ancestors(id,parent_id) AS (SELECT id,parent_id FROM classification_entries WHERE id=?1 UNION ALL
                SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id)
                SELECT a.id,a.content_hash,a.relative_path FROM assets a
                WHERE a.status='normal' AND a.media_kind='image'
                AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND  (ac.classification_id IN (SELECT id FROM scope) OR (?3 AND ac.classification_id IN (SELECT id FROM ancestors WHERE parent_id IS NULL))))
                AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.target_id=?2 AND r.asset_id=a.id) ORDER BY a.id")?;
            let rows = statement
                .query_map(params![target.series_classification_id, target.id, automatic], |r| {
                    Ok(ScanInput {
                        id: r.get(0)?,
                        hash: r.get(1)?,
                        path: r.get(2)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        Ok(inputs)
    }

    fn run_character_scan(
        &self,
        target: &Target,
        config: RuntimeConfig,
        cancel: Arc<AtomicBool>,
        automatic: bool,
    ) -> Result<()> {
        let references = self.reference_inputs(target)?;
        let inputs = self.character_scan_inputs_mode(target, automatic)?.into_iter().filter(|input| !references.iter().any(|r| r.hash == input.hash)).collect::<Vec<_>>();
        {
            let mut state = self
                .character_scan
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.status.as_mut().unwrap().total = 0;
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
        let comparisons = Comparisons::open(self)?;
        let mut pending = Vec::new();
        for input in inputs {
            let key = Comparisons::key(self, target, runtime, &input).ok();
            if let Some(mut row) = key.as_deref().map(|key| comparisons.get(key)).transpose()?.flatten() {
                if let Some(evidence) = row.evidence.as_mut() {
                    evidence["automaticScope"] = json!(automatic);
                }
                self.character_scan.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
                    .results.insert(input.id, row);
            } else {
                pending.push((input, key));
            }
        }
        {
            let mut state = self.character_scan.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let reused = state.results.len() - pending.len();
            let status = state.status.as_mut().unwrap();
            status.total = pending.len();
            status.reused = reused;
        }
        if pending.is_empty() {
            self.ensure_current_target(target)?;
            return Ok(());
        }
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
        for (input, comparison_key) in pending {
            if cancel.load(Ordering::Acquire) {
                return Err(Error::Worker("취소됨".into()));
            }
            self.ensure_current_target(target)?;
            let current = self.current_input_mode(target, &input.id, automatic);
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
                match self.current_input_mode(target, &input.id, automatic).and_then(|current| {
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
                        row.evidence.as_mut().unwrap()["learnedReferences"] = json!(target.learned_references);
                        row.evidence.as_mut().unwrap()["automaticScope"] = json!(automatic);
                    }
                    Err(_) => row.state = "stale".into(),
                }
            } else {
                row.error = Some(event["error"].as_str().unwrap_or("이미지 분석 실패").into());
            }
            if let Some(key) = comparison_key { comparisons.put(&target.id, &key, &row)?; }
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
            let (hash,path) = super::character_hub::candidate_image_mode(connection,series,&row.asset_id,status.automatic)?;
            if hash != row.content_hash { return Err(Error::Stale); }
            self.verify_input(&ScanInput {id:row.asset_id.clone(),hash,path})?;
            let evidence = row.evidence.ok_or(Error::Stale)?;
            if evidence.get("learnedReferences").is_some()
                && evidence["learnedReferences"] != serde_json::to_value(&target.learned_references)? {
                return Err(Error::Stale);
            }
            if let Some(learned) = evidence["learnedReferences"].as_array() {
                for reference in learned {
                    let learned_id = reference["assetId"].as_str().ok_or(Error::Stale)?;
                    let learned_hash = reference["assetHash"].as_str().ok_or(Error::Stale)?;
                    let valid: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM character_relations r JOIN character_decisions d ON d.sequence=r.sequence
                        WHERE r.target_id=?1 AND r.asset_id=?2 AND d.origin='manual' AND d.asset_hash=?3
                        AND NOT EXISTS(SELECT 1 FROM character_relations other WHERE other.asset_id=r.asset_id AND other.target_id<>r.target_id))", params![target.id,learned_id,learned_hash], |r| r.get(0))?;
                    if !valid { return Err(Error::Stale); }
                    let (hash,path) = characters::scoped_image(connection,series,learned_id)?;
                    if hash != learned_hash { return Err(Error::Stale); }
                    self.verify_input(&ScanInput {id:learned_id.into(),hash,path})?;
                }
            }
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

impl Library {
    /// Auto approval is deliberately narrower than recommendation. It never replaces a human decision.
    pub fn apply_automatic_characters(&self, scan_ids: Vec<String>) -> Result<u64> {
        use characters::{DecisionKind, DecisionRequest};
        let allowed = self.character_series()?.into_iter().filter(|s| s.auto_classify).map(|s| s.classification_id).collect::<std::collections::BTreeSet<_>>();
        let all_targets = self.list_character_targets()?;
        let (requested_series, automatic_batch) = {
            let state = self.character_scan.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let automatic = scan_ids.iter().filter_map(|id| state.find(id)).any(|(s,_)| s.automatic);
            (scan_ids.iter().filter_map(|id| state.find(id)).filter_map(|(status,_)| all_targets.iter().find(|t| t.id == status.target_id).and_then(|t| t.series_classification_id.clone())).collect::<std::collections::BTreeSet<_>>(), automatic)
        };
        let targets = all_targets.into_iter().filter(|t| t.ready && t.series_classification_id.as_ref().is_some_and(|s| allowed.contains(s) && (automatic_batch || requested_series.contains(s)))).collect::<Vec<_>>();
        if targets.is_empty() { return Ok(0); }
        // Copy before acquiring SQLite: decision validation uses DB -> scan lock order.
        let snapshots = {
            let state = self.character_scan.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut snapshots = Vec::new();
            for target in &targets {
                let Some((status, rows)) = scan_ids.iter().filter_map(|id| state.find(id)).find(|(s,_)| s.target_id == target.id) else { continue; };
                if !matches!(status.state.as_str(), "running" | "completed") || status.target_fingerprint != target.fingerprint { continue; }
                snapshots.push((target.clone(),status.clone(),rows.clone()));
            }
            snapshots
        };
        let mut by_asset: BTreeMap<String,Vec<usize>> = BTreeMap::new();
        for (index,(_,_,rows)) in snapshots.iter().enumerate() {
            for (id,row) in rows {
                if row.state == "recommended" { by_asset.entry(id.clone()).or_default().push(index); }
            }
        }
        let mut connection = self.connection()?;
        let mut changed = 0;
        for (asset_id, candidates) in by_asset {
            // Every applicable character must have a final result for this image.
            let transaction = connection.transaction()?;
            let blocked = transaction.prepare("SELECT DISTINCT target_id FROM character_decisions WHERE source_asset_id=?1 AND decision IN ('rejected','cleared')")?
                .query_map([&asset_id], |r| r.get::<_,String>(0))?
                .collect::<std::result::Result<std::collections::BTreeSet<_>,_>>()?;
            let incomplete = targets.iter().any(|target| {
                if blocked.contains(&target.id) { return false; }
                let row = snapshots.iter().find(|(t,_,_)| t.id == target.id).and_then(|(_,_,rows)| rows.get(&asset_id));
                !row.is_some_and(|r| matches!(r.state.as_str(), "recommended" | "unmatched"))
                    && target.series_classification_id.as_ref().is_some_and(|series|
                        super::character_hub::candidate_image_mode(&transaction,series,&asset_id,automatic_batch).is_ok())
            });
            if incomplete { continue; }
            let permitted = candidates.into_iter().filter(|index| !blocked.contains(&snapshots[*index].0.id)).collect::<Vec<_>>();
            let mut accepted = Vec::new();
            for &index in &permitted {
                let (target,status,rows) = &snapshots[index];
                let row = &rows[&asset_id];
                if !automatic_evidence(row.evidence.as_ref()) { continue; }
                let strong = evidence_regions(row.evidence.as_ref(), 3);
                let unambiguous = strong.as_ref().is_some_and(|regions| regions.iter().any(|region| {
                    permitted.iter().filter(|other| **other != index).all(|other| {
                        evidence_regions(snapshots[*other].2[&asset_id].evidence.as_ref(), 2)
                            .is_some_and(|others| others.iter().all(|other| !same_person(region, other)))
                    })
                })) || permitted.len() == 1;
                if !unambiguous { continue; }
                let judged: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM character_decisions WHERE source_asset_id=?1 AND target_id=?2)",
                    params![asset_id,target.id], |r| r.get(0))?;
                if judged { continue; }
                accepted.push((target,status));
            }
            let mut applied_count = 0;
            for (target,status) in &accepted {
                let applied = self.write_character_decisions(&transaction, DecisionRequest {
                    target_id:target.id.clone(),expected_fingerprint:target.fingerprint.clone(),asset_ids:vec![asset_id.clone()],
                    decision:DecisionKind::Accepted,baseline_fingerprint:status.runtime_fingerprint.clone(),scan_id:Some(status.id.clone()),
                })?;
                if applied > 0 {
                    transaction.execute("UPDATE character_decisions SET origin='automatic' WHERE sequence=(SELECT MAX(sequence) FROM character_decisions WHERE target_id=?1 AND source_asset_id=?2)", params![target.id,asset_id])?;
                    applied_count += applied;
                }
            }
            // Keep the one ordinary folder contract; character folders are shared references.
            let series = transaction.prepare("SELECT DISTINCT t.series_classification_id FROM character_relations r JOIN character_targets t ON t.id=r.target_id WHERE r.asset_id=?1 AND t.series_classification_id IS NOT NULL")?
                .query_map([&asset_id], |r| r.get::<_,String>(0))?
                .collect::<std::result::Result<std::collections::BTreeSet<_>,_>>()?;
            if series.len() == 1 && accepted.iter().any(|(_,status)| status.automatic) {
                let series = series.first().unwrap();
                let at_root: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM asset_classifications ac JOIN classification_entries c ON c.id=ac.classification_id WHERE ac.asset_id=?1 AND c.parent_id IS NULL AND c.id<>?2)", params![asset_id,series], |r| r.get(0))?;
                if at_root {
                    Self::set_asset_classification_in(&transaction, &super::models::SetAssetClassification {
                        asset_ids: vec![asset_id.clone()], classification_id: Some(series.clone()),
                    })?;
                }
            }
            transaction.commit()?;
            changed += applied_count;
        }
        Ok(changed)
    }
}
fn automatic_evidence(evidence: Option<&Value>) -> bool {
    let Some(e) = evidence else { return false; };
    if e["passed"] != true || e["wholeFallback"] == true { return false; }
    let Some(crop) = e["bestQueryCrop"].as_u64() else { return false; };
    e["evidence"].as_array().and_then(|rows| rows.get(crop as usize))
        .and_then(|row| row["matchedReferences"].as_array())
        .is_some_and(|refs| refs.len() >= 3)
}

// Compare geometry as well as crop indexes: duplicate/overlapping detections are one person.
fn evidence_regions(evidence: Option<&Value>, minimum: usize) -> Option<Vec<[f64; 4]>> {
    let e = evidence?;
    if e["wholeFallback"] == true { return None; }
    let boxes = e["queryBoxes"].as_array()?;
    let mut regions = Vec::new();
    for (index, row) in e["evidence"].as_array()?.iter().enumerate() {
        if row["matchedReferences"].as_array()?.len() < minimum { continue; }
        let b = boxes.get(index)?.as_array()?;
        if b.len() != 4 { return None; }
        let region = [b[0].as_f64()?, b[1].as_f64()?, b[2].as_f64()?, b[3].as_f64()?];
        if region.iter().any(|v| !v.is_finite()) || region[2] <= region[0] || region[3] <= region[1] { return None; }
        regions.push(region);
    }
    Some(regions)
}

fn same_person(a: &[f64; 4], b: &[f64; 4]) -> bool {
    let intersection = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0)
        * (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    let smaller = ((a[2]-a[0])*(a[3]-a[1])).min((b[2]-b[0])*(b[3]-b[1]));
    intersection / smaller >= 0.5
}
