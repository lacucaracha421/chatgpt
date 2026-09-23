//! Explicit, disposable history scoring on the native owner's idle turns.
use super::{
    character_shadow::{Cache, Pending, Policy},
    character_worker::RuntimeConfig,
    characters::{Error, Result},
    Library,
};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

const BATCH_SIZE: usize = 32;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub preparing: bool,
    pub total: usize,
    pub scored: usize,
    pub skipped: usize,
    pub cancelled: bool,
    pub error: Option<String>,
}
#[derive(Debug, Default)]
pub(super) struct State {
    status: Status,
    pending: VecDeque<Pending>,
    cancel: Arc<AtomicBool>,
}

fn take_batch(pending: &mut VecDeque<Pending>) -> Vec<Pending> {
    let mut batch = Vec::new();
    while batch.len() < BATCH_SIZE {
        let Some(next) = pending.front() else {
            break;
        };
        if batch
            .first()
            .is_some_and(|first: &Pending| first.outcomes != next.outcomes)
        {
            break;
        }
        batch.push(pending.pop_front().unwrap());
    }
    batch
}

impl Library {
    pub fn character_shadow_backfill_status(&self) -> Status {
        self.character_shadow_backfill
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .status
            .clone()
    }
    pub fn character_shadow_backfill_cancel(&self) -> Status {
        let mut state = self
            .character_shadow_backfill
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.status.running {
            state.cancel.store(true, Ordering::Release);
            state.status.running = false;
            state.status.preparing = false;
            state.status.cancelled = true;
            state.pending.clear();
        }
        state.status.clone()
    }
    pub fn character_shadow_backfill_start(&self) -> Result<Status> {
        self.character_shadow_backfill_available()?;
        let cancel = {
            let mut state = self
                .character_shadow_backfill
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.status.running {
                return Ok(state.status.clone());
            }
            *state = State {
                status: Status {
                    running: true,
                    preparing: true,
                    ..Status::default()
                },
                ..State::default()
            };
            state.cancel.clone()
        };
        // No queue registration or library writes. Release the library connection
        // between candidates so native work is not held behind a history scan.
        let result = (|| -> Result<VecDeque<Pending>> {
            let ids = self.connection()?.prepare("SELECT id FROM assets WHERE status='normal' AND media_kind='image' ORDER BY id")?
                .query_map([], |r| r.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
            let at = chrono::Utc::now().to_rfc3339();
            let mut candidates = Vec::new();
            for id in ids {
                if cancel.load(Ordering::Acquire) {
                    break;
                }
                if let Some(mut pending) = self.character_shadow_candidate(&id)? {
                    pending.native_at = at.clone();
                    candidates.push(pending);
                }
            }
            // Identical target rosters imply identical series metadata snapshots.
            // Manual pair exclusions can split a series into several rosters.
            candidates.sort_by(|a, b| a.outcomes.keys().cmp(b.outcomes.keys()));
            Ok(candidates.into())
        })();
        let mut state = self
            .character_shadow_backfill
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if cancel.load(Ordering::Acquire) {
            return Ok(state.status.clone());
        }
        state.status.preparing = false;
        match result {
            Ok(candidates) => {
                state.status.total = candidates.len();
                state.status.running = !candidates.is_empty();
                state.pending = candidates;
            }
            Err(error) => {
                state.status.running = false;
                state.status.error = Some(error.to_string());
            }
        }
        Ok(state.status.clone())
    }

    pub(super) fn character_shadow_candidate(&self, id: &str) -> Result<Option<Pending>> {
        let c = self.connection()?;
        let asset: Option<(String, String)> = c.query_row(
            "SELECT content_hash,relative_path FROM assets WHERE id=?1 AND status='normal' AND media_kind='image' AND content_hash IS NOT NULL",
            [id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let Some((content_hash, relative_path)) = asset else {
            return Ok(None);
        };
        let mut outcomes = BTreeMap::new();
        for target in self.character_autotag_targets(&c, id)? {
            let manual: Option<String> = c.query_row(
                "SELECT decision FROM character_decisions WHERE source_asset_id=?1 AND target_id=?2 AND origin='manual' ORDER BY sequence DESC LIMIT 1",
                params![id,target.id], |r| r.get(0)).optional()?;
            if manual.is_none() || manual.as_deref() == Some("cleared") {
                // Record what the native pass already decided, like the live path does.
                let native: Option<String> = c.query_row(
                    "SELECT decision FROM character_decisions WHERE source_asset_id=?1 AND target_id=?2 AND origin<>'manual' ORDER BY sequence DESC LIMIT 1",
                    params![id,target.id], |r| r.get(0)).optional()?;
                let outcome = if native.as_deref() == Some("accepted") {
                    "accepted_automatic"
                } else {
                    "none"
                };
                outcomes.insert(target.id, outcome.into());
            }
        }
        Ok((!outcomes.is_empty()).then(|| Pending {
            asset_id: id.into(),
            content_hash,
            relative_path,
            outcomes,
            native_at: chrono::Utc::now().to_rfc3339(),
        }))
    }

    pub(super) fn advance_character_shadow_backfill(
        &self,
        config: &RuntimeConfig,
        stop: Arc<AtomicBool>,
    ) -> bool {
        if config.shadow_model.is_none() || !self.augmentation_idle_allowed(&stop).unwrap_or(false)
        {
            return false;
        }
        let (pending, cancel) = {
            let mut state = self
                .character_shadow_backfill
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !state.status.running || state.status.preparing {
                return false;
            }
            let pending = take_batch(&mut state.pending);
            if pending.is_empty() {
                return false;
            }
            (pending, state.cancel.clone())
        };
        let mut completed = 0;
        let result =
            self.score_shadow_backfill(&pending, config, stop.clone(), &cancel, |scored| {
                completed += 1;
                let mut state = self
                    .character_shadow_backfill
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if !cancel.load(Ordering::Acquire) {
                    if scored {
                        state.status.scored += 1;
                    } else {
                        state.status.skipped += 1;
                    }
                }
            });
        let mut state = self
            .character_shadow_backfill
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if cancel.load(Ordering::Acquire) {
            return true;
        }
        match result {
            Ok(()) => {}
            Err(_) if !self.augmentation_idle_allowed(&stop).unwrap_or(false) => {
                for item in pending.into_iter().skip(completed).rev() {
                    state.pending.push_front(item);
                }
                return true;
            }
            Err(error) => {
                state.status.error = Some(error.to_string());
                state.status.running = false;
                state.pending.clear();
            }
        }
        if state.pending.is_empty() {
            state.status.running = false;
        }
        true
    }

    fn score_shadow_backfill(
        &self,
        originals: &[Pending],
        config: &RuntimeConfig,
        stop: Arc<AtomicBool>,
        cancel: &AtomicBool,
        mut progress: impl FnMut(bool),
    ) -> Result<()> {
        let allowed = || -> Result<bool> {
            Ok(!cancel.load(Ordering::Acquire) && self.augmentation_idle_allowed(&stop)?)
        };
        if !allowed()? {
            return Err(Error::Stale);
        }
        let policy_path = config.script.with_file_name("s36_policy.json");
        let policy_value: Value = serde_json::from_slice(&std::fs::read(&policy_path)?)?;
        let policy = Policy::load(
            &policy_path,
            policy_value["feature_id"].as_str().ok_or(Error::Stale)?,
        )?;
        let cache_root = self.root.join(".cache/characters");
        let feature_root = cache_root
            .join("s36-augmentation-v1")
            .join(&policy.feature_id);
        let mut candidates = Vec::new();
        for original in originals {
            if !allowed()? {
                return Err(Error::Stale);
            }
            let pending = self
                .character_shadow_candidate(&original.asset_id)?
                .filter(|p| {
                    p.content_hash == original.content_hash && p.outcomes == original.outcomes
                })
                .filter(|p| super::character_augmentation::is_hash(&json!(p.content_hash)))
                .filter(|p| {
                    feature_root
                        .join(format!("{}.npz", p.content_hash))
                        .is_file()
                })
                .map(|mut p| {
                    p.native_at = original.native_at.clone();
                    p
                });
            candidates.push(pending);
        }
        let queries: Vec<_> = candidates.iter().flatten().collect();
        let mut results = Vec::new();
        let at = &originals.first().ok_or(Error::Stale)?.native_at;
        let mut rejections = 0;
        if let Some(first) = queries.first() {
            // One read transaction and metadata file for the entire roster batch.
            let snapshot = {
                let mut c = self.connection()?;
                let tx = c.transaction()?;
                let (snapshot, count) = super::character_shadow::snapshot(&tx, first)?;
                rejections = count;
                snapshot
            };
            let mut file = tempfile::NamedTempFile::new()?;
            file.write_all(&serde_json::to_vec(&snapshot)?)?;
            file.flush()?;
            let response = self.character_worker_pool.with(config, &cache_root, stop.clone(), false, |worker, ready| {
                if !allowed()? {
                    return Ok(Value::Null);
                }
                if ready["s36FeatureId"] != policy.feature_id {
                    return Ok(json!({"type":"s36_shadow_unavailable", "reason":"S36 feature identity mismatch"}));
                }
                worker.send(&json!({"type":"s36_shadow", "cachedOnly":true,
                    "queries":queries.iter().map(|p| json!({"assetId":p.asset_id,"hash":p.content_hash})).collect::<Vec<_>>(),
                    "snapshotPath":file.path(),"featureId":policy.feature_id,
                    "targets":first.outcomes.keys().collect::<Vec<_>>(),"scoredAt":at}))?;
                worker.receive_while(std::time::Duration::from_secs(120), allowed)
            })?;
            if !allowed()? {
                return Err(Error::Stale);
            }
            if response["type"] != "s36_shadow_batch_result" {
                return Err(Error::Worker(format!(
                    "S36 shadow unavailable: {}",
                    response["reason"]
                )));
            }
            results = response["results"].as_array().ok_or(Error::Stale)?.clone();
            if results.len() != queries.len() {
                return Err(Error::Stale);
            }
            for (pending, response) in queries.iter().zip(&results) {
                if response["type"] != "s36_shadow_result"
                    || response["assetId"] != pending.asset_id
                    || response["contentHash"] != pending.content_hash
                    || response["featureId"] != policy.feature_id
                    || !response["queryAvailable"].is_boolean()
                {
                    return Err(Error::Stale);
                }
            }
        }
        let mut results = results.into_iter();
        let mut cache = None;
        for pending in candidates {
            if !allowed()? {
                return Err(Error::Stale);
            }
            let mut scored = false;
            if let Some(pending) = pending {
                let response = results.next().ok_or(Error::Stale)?;
                if response["queryAvailable"] == true {
                    // Fence cancel/restart and recheck manual scope for every image.
                    let state = self
                        .character_shadow_backfill
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if cancel.load(Ordering::Acquire) {
                        return Err(Error::Stale);
                    }
                    if self
                        .character_shadow_candidate(&pending.asset_id)?
                        .is_some_and(|p| {
                            p.content_hash == pending.content_hash && p.outcomes == pending.outcomes
                        })
                    {
                        if cache.is_none() {
                            cache = Some(Cache::open(&self.root)?);
                        }
                        cache.as_mut().unwrap().record_origin(
                            &pending, &policy, &response, rejections, at, "backfill",
                        )?;
                        scored = true;
                    }
                    drop(state);
                }
            }
            progress(scored);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::characters::{tests::Fixture, DecisionKind, DecisionRequest, Target};
    use super::*;

    fn decide(f: &Fixture, target: &Target, decision: DecisionKind) {
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: vec!["asset-5".into()],
                decision,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
    }

    fn config(f: &Fixture) -> RuntimeConfig {
        let script = f.temp.path().join("worker.py");
        std::fs::write(
            script.with_file_name("s36_policy.json"),
            include_str!("../../../character-runtime/s36_policy.json"),
        )
        .unwrap();
        RuntimeConfig {
            python: std::env::var_os("LAKOMICS_CHARACTER_TEST_PYTHON")
                .map(Into::into)
                .unwrap_or_else(|| "unused".into()),
            script,
            models: f.temp.path().into(),
            augmentation_model: None,
            shadow_model: Some(f.temp.path().join("unused-model")),
            s36_shadow_disabled: false,
        }
    }
    fn idle(f: &Fixture, config: &RuntimeConfig) {
        *f.library.character_incremental.lock().unwrap() =
            super::super::character_incremental::Engine::shadow_fixture(config.clone());
        let c = f.library.connection().unwrap();
        c.execute_batch("DELETE FROM character_autotag_jobs; DELETE FROM character_reference_refreshes; UPDATE character_autotag_control SET paused=0,reference_refresh_paused=0; PRAGMA query_only=ON;").unwrap();
    }

    #[test]
    fn character_shadow_backfill_batch_boundaries_preserve_rosters_and_order() {
        let make = |index, target: &str| Pending {
            asset_id: format!("asset-{index}"),
            content_hash: "a".repeat(64),
            relative_path: "unused".into(),
            native_at: "2026-01-01T00:00:00Z".into(),
            outcomes: BTreeMap::from([(target.into(), "none".into())]),
        };
        let mut queue: VecDeque<_> = (0..BATCH_SIZE + 1).map(|i| make(i, "series-a")).collect();
        queue.push_back(make(BATCH_SIZE + 1, "series-b"));
        assert_eq!(take_batch(&mut queue).len(), BATCH_SIZE);
        let remainder = take_batch(&mut queue);
        assert_eq!(remainder.len(), 1);
        assert_eq!(remainder[0].asset_id, format!("asset-{BATCH_SIZE}"));
        assert_eq!(
            take_batch(&mut queue)[0].outcomes.keys().next().unwrap(),
            "series-b"
        );
        assert!(take_batch(&mut queue).is_empty());
    }

    #[test]
    #[ignore = "requires LAKOMICS_CHARACTER_TEST_PYTHON; TEMP batch protocol worker"]
    fn character_shadow_backfill_batches_yield_count_images_and_preserve_newer_live() {
        let f = Fixture::new();
        let target = f.ready("Batch progress");
        let cfg = config(&f);
        let policy: Policy =
            serde_json::from_str(include_str!("../../../character-runtime/s36_policy.json"))
                .unwrap();
        let feature_root = f
            .temp
            .path()
            .join(".cache/characters/s36-augmentation-v1")
            .join(&policy.feature_id);
        std::fs::create_dir_all(&feature_root).unwrap();
        let log = f.temp.path().join("batches.jsonl");
        std::fs::write(&cfg.script, format!(r#"import sys, json
print(json.dumps({{'type':'ready','baselineFingerprint':{baseline},'s36FeatureId':{identity}}}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    assert request['type'] == 's36_shadow' and request['cachedOnly']
    queries = request['queries']
    assert 1 <= len(queries) <= 32
    with open({log}, 'a') as output:
        output.write(json.dumps({{'count':len(queries), 'snapshot':request['snapshotPath'], 'at':request['scoredAt']}}) + '\n')
    results = [{{'type':'s36_shadow_result','assetId':q['assetId'],'contentHash':q['hash'],
                'featureId':request['featureId'],'queryAvailable':True,
                'scores':{{t:0.1 for t in request['targets']}}}} for q in queries]
    print(json.dumps({{'type':'s36_shadow_batch_result','results':results}}), flush=True)
"#, baseline=json!(super::super::character_worker::BASELINE), identity=json!(policy.feature_id), log=json!(log))).unwrap();
        {
            let c = f.library.connection().unwrap();
            for i in 0..65 {
                let id = format!("batch-{i:02}");
                let hash = format!("{:064x}", i + 256);
                if i < 64 {
                    std::fs::write(
                        feature_root.join(format!("{hash}.npz")),
                        b"protocol fixture",
                    )
                    .unwrap();
                }
                c.execute("INSERT INTO assets(id,content_hash,media_kind,original_name,relative_path,thumbnail_relative_path,byte_size,width,height,collected_at,status) VALUES(?1,?2,'image',?1,?1,?1,1,1,1,'2026-01-01','normal')", params![id,hash]).unwrap();
                c.execute(
                    "INSERT INTO asset_classifications VALUES(?1,?2)",
                    params![id, f.series],
                )
                .unwrap();
            }
        }
        idle(&f, &cfg);
        let at = chrono::Utc::now().to_rfc3339();
        let pending: VecDeque<_> = (0..65)
            .map(|i| {
                let mut p = f
                    .library
                    .character_shadow_candidate(&format!("batch-{i:02}"))
                    .unwrap()
                    .unwrap();
                p.native_at = at.clone();
                p
            })
            .collect();
        let first = pending.front().unwrap();
        let response = json!({"type":"s36_shadow_result","assetId":first.asset_id,
            "contentHash":first.content_hash,"featureId":policy.feature_id,"scores":{target.id.clone():0.1}});
        Cache::open(f.temp.path())
            .unwrap()
            .record(first, &policy, &response, 100, "2099-01-01T00:00:00Z")
            .unwrap();
        {
            let mut state = f.library.character_shadow_backfill.lock().unwrap();
            state.pending = pending;
            state.status = Status {
                running: true,
                total: 65,
                ..Status::default()
            };
        }
        let before = f.library.connection().unwrap().total_changes();
        assert!(f
            .library
            .advance_character_shadow_backfill(&cfg, Arc::default()));
        let status = f.library.character_shadow_backfill_status();
        assert!(status.running);
        assert_eq!((status.scored, status.skipped), (32, 0));
        assert!(!f
            .library
            .advance_character_shadow_backfill(&cfg, Arc::new(AtomicBool::new(true))));
        assert_eq!(f.library.character_shadow_backfill_status().scored, 32);
        assert!(f
            .library
            .advance_character_shadow_backfill(&cfg, Arc::default()));
        assert_eq!(f.library.character_shadow_backfill_status().scored, 64);
        assert!(f
            .library
            .advance_character_shadow_backfill(&cfg, Arc::default()));
        let status = f.library.character_shadow_backfill_status();
        assert!(!status.running && status.error.is_none());
        assert_eq!((status.total, status.scored, status.skipped), (65, 64, 1));
        let requests: Vec<Value> = std::fs::read_to_string(log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|r| r["count"] == 32 && r["at"] == at));
        assert_ne!(requests[0]["snapshot"], requests[1]["snapshot"]);
        let cache =
            rusqlite::Connection::open(f.temp.path().join(".cache/characters/s36_shadow.sqlite"))
                .unwrap();
        assert_eq!(
            cache
                .query_row(
                    "SELECT COUNT(*) FROM scores WHERE origin='backfill'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            63
        );
        assert_eq!(
            cache
                .query_row(
                    "SELECT origin FROM scores WHERE asset_id='batch-00'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "live"
        );
        assert_eq!(
            cache
                .query_row(
                    "SELECT COUNT(*) FROM scores WHERE origin='backfill' AND verdict='recommended'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            63
        );
        assert_eq!(
            cache
                .query_row(
                    "SELECT verdict FROM scores WHERE asset_id='batch-00'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "automatic"
        );
        // Stop publication between images, even after a complete batch reply.
        let candidates: Vec<_> = (1..3)
            .map(|i| {
                f.library
                    .character_shadow_candidate(&format!("batch-{i:02}"))
                    .unwrap()
                    .unwrap()
            })
            .collect();
        let cancel = AtomicBool::new(false);
        let mut published = 0;
        let result =
            f.library
                .score_shadow_backfill(&candidates, &cfg, Arc::default(), &cancel, |scored| {
                    assert!(scored);
                    published += 1;
                    cancel.store(true, Ordering::Release);
                });
        assert!(matches!(result, Err(Error::Stale)));
        assert_eq!(published, 1);
        assert_eq!(f.library.connection().unwrap().total_changes(), before);
        f.library
            .connection()
            .unwrap()
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
    }

    #[test]
    fn character_shadow_backfill_scope_enabled_manual_clear_and_missing_cache() {
        let f = Fixture::new();
        let target = f.ready("History");
        assert!(f
            .library
            .character_shadow_candidate("asset-5")
            .unwrap()
            .unwrap()
            .outcomes
            .contains_key(&target.id));
        assert!(f
            .library
            .character_shadow_candidate("asset-6")
            .unwrap()
            .is_none());
        for decision in [DecisionKind::Accepted, DecisionKind::Rejected] {
            decide(&f, &target, decision);
            assert!(f
                .library
                .character_shadow_candidate("asset-5")
                .unwrap()
                .is_none());
        }
        decide(&f, &target, DecisionKind::Cleared);
        assert!(f
            .library
            .character_shadow_candidate("asset-5")
            .unwrap()
            .is_some());
        for (sql, inverse) in [
            (
                "UPDATE character_targets SET enabled=0",
                "UPDATE character_targets SET enabled=1",
            ),
            (
                "UPDATE character_targets SET manual_only=1",
                "UPDATE character_targets SET manual_only=0",
            ),
            (
                "UPDATE character_series SET auto_classify=0",
                "UPDATE character_series SET auto_classify=1",
            ),
            (
                "UPDATE assets SET media_kind='video' WHERE id='asset-5'",
                "UPDATE assets SET media_kind='image' WHERE id='asset-5'",
            ),
            (
                "UPDATE assets SET status='trash' WHERE id='asset-5'",
                "UPDATE assets SET status='normal' WHERE id='asset-5'",
            ),
        ] {
            f.library.connection().unwrap().execute_batch(sql).unwrap();
            assert!(
                f.library
                    .character_shadow_candidate("asset-5")
                    .unwrap()
                    .is_none(),
                "{sql}"
            );
            f.library
                .connection()
                .unwrap()
                .execute_batch(inverse)
                .unwrap();
        }
        let cfg = config(&f);
        idle(&f, &cfg);
        let before = f.library.connection().unwrap().total_changes();
        let first = f.library.character_shadow_backfill_start().unwrap();
        assert!(first.total > 0);
        assert_eq!(
            f.library.character_shadow_backfill_start().unwrap().total,
            first.total
        );
        while f.library.character_shadow_backfill_status().running {
            assert!(f
                .library
                .advance_character_shadow_backfill(&cfg, Arc::default()));
        }
        let status = f.library.character_shadow_backfill_status();
        assert_eq!(status.scored, 0);
        assert_eq!(status.skipped, first.total);
        assert!(status.error.is_none());
        assert_eq!(f.library.connection().unwrap().total_changes(), before);
        assert!(!f
            .temp
            .path()
            .join(".cache/characters/s36_shadow.sqlite")
            .exists());
        f.library
            .connection()
            .unwrap()
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
    }

    #[test]
    fn character_shadow_backfill_decisions_are_per_pair_and_exclusions_stay_in_scope() {
        let f = Fixture::new();
        let first = f.ready("First");
        let second = f.ready_in_series("Second", &f.series);
        let candidate = || f.library.character_shadow_candidate("asset-5").unwrap();
        assert_eq!(candidate().unwrap().outcomes.len(), 2);
        decide(&f, &first, DecisionKind::Accepted);
        assert_eq!(
            candidate().unwrap().outcomes.keys().collect::<Vec<_>>(),
            vec![&second.id]
        );
        f.library.connection().unwrap().execute("INSERT INTO character_series_asset_exclusions(series_id,asset_id,created_at) VALUES(?1,'asset-5','2026-01-01')", [&f.series]).unwrap();
        assert!(candidate().is_none());
    }

    #[test]
    fn character_shadow_backfill_cancel_and_native_pause_yield() {
        let f = Fixture::new();
        f.ready("Cancel");
        let cfg = config(&f);
        idle(&f, &cfg);
        f.library.character_shadow_backfill_start().unwrap();
        let stop = Arc::new(AtomicBool::new(true));
        assert!(!f.library.advance_character_shadow_backfill(&cfg, stop));
        assert_eq!(f.library.character_shadow_backfill_status().skipped, 0);
        let cancelled = f.library.character_shadow_backfill_cancel();
        assert!(cancelled.cancelled && !cancelled.running);
        assert!(!f
            .library
            .advance_character_shadow_backfill(&cfg, Arc::default()));
        assert_eq!(f.library.character_shadow_backfill_status().skipped, 0);
        f.library
            .connection()
            .unwrap()
            .execute_batch("PRAGMA query_only=OFF; UPDATE character_autotag_control SET paused=1;")
            .unwrap();
        f.library.character_shadow_backfill_start().unwrap();
        assert!(!f
            .library
            .advance_character_shadow_backfill(&cfg, Arc::default()));
        f.library.character_shadow_backfill_cancel();
    }

    #[test]
    #[ignore = "requires LAKOMICS_CHARACTER_TEST_PYTHON; TEMP cache-only Python worker"]
    fn character_shadow_backfill_worker_excludes_transitive_group_and_never_infers() {
        let f = Fixture::new();
        let target = f.ready("Groups");
        let cfg = config(&f);
        let runtime = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../character-runtime");
        let script = format!(
            r#"import sys, json, hashlib
from types import SimpleNamespace
sys.path.insert(0, {runtime})
from test_s36_shadow import feature
from character_augmentation import S36FeatureCache
from character_encoder import feature_id
from s36_shadow import handle
root = {root}
cache = S36FeatureCache(root + '/.cache/characters', cleanup=False)
if '--prepare-fixture' in sys.argv:
    for asset in ['asset-0', 'asset-5']:
        h = hashlib.sha256(asset.encode()).hexdigest()
        cache.write(feature(h, 0))
    raise SystemExit()
model = SimpleNamespace(cache_root=root + '/.cache/characters')
print(json.dumps({{'type':'ready','baselineFingerprint':{baseline},'s36FeatureId':feature_id()}}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    assert request['cachedOnly'] is True and 'path' not in request
    print(json.dumps(handle(model, request)), flush=True)
"#,
            runtime = json!(runtime),
            root = json!(f.temp.path()),
            baseline = json!(super::super::character_worker::BASELINE)
        );
        std::fs::write(&cfg.script, script).unwrap();
        assert!(std::process::Command::new(&cfg.python)
            .arg("-B")
            .arg(&cfg.script)
            .arg("--prepare-fixture")
            .status()
            .unwrap()
            .success());
        idle(&f, &cfg);
        let pending = f
            .library
            .character_shadow_candidate("asset-5")
            .unwrap()
            .unwrap();
        let mut progress = Vec::new();
        f.library
            .score_shadow_backfill(
                std::slice::from_ref(&pending),
                &cfg,
                Arc::default(),
                &AtomicBool::new(false),
                |scored| progress.push(scored),
            )
            .unwrap();
        assert_eq!(progress, vec![true]);
        let cache =
            rusqlite::Connection::open(f.temp.path().join(".cache/characters/s36_shadow.sqlite"))
                .unwrap();
        let first: f64 = cache
            .query_row(
                "SELECT knn3 FROM scores WHERE asset_id='asset-5' AND target_id=?1",
                [&target.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(first, 0.0);
        {
            let c = f.library.connection().unwrap();
            c.execute_batch("PRAGMA query_only=OFF; UPDATE assets SET source_url='https://x.com/a/status/1' WHERE id IN ('asset-0','asset-1');").unwrap();
            c.execute(
                "UPDATE assets SET perceptual_hash=?1 WHERE id='asset-1'",
                [vec![0u8; 64]],
            )
            .unwrap();
            let mut near = vec![0u8; 64];
            near[0] = 1;
            c.execute(
                "UPDATE assets SET perceptual_hash=?1 WHERE id='asset-5'",
                [near],
            )
            .unwrap();
            c.execute_batch("PRAGMA query_only=ON").unwrap();
        }
        let mut progress = Vec::new();
        f.library
            .score_shadow_backfill(
                std::slice::from_ref(&pending),
                &cfg,
                Arc::default(),
                &AtomicBool::new(false),
                |scored| progress.push(scored),
            )
            .unwrap();
        assert_eq!(progress, vec![true]);
        let row: (Option<f64>, String, String) = cache
            .query_row(
                "SELECT knn3,verdict,origin FROM scores WHERE asset_id='asset-5' AND target_id=?1",
                [&target.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, (None, "abstain".into(), "backfill".into()));
        f.library
            .connection()
            .unwrap()
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
    }
    #[test]
    #[ignore = "requires LAKOMICS_CHARACTER_TEST_PYTHON; TEMP cooperative worker"]
    fn character_shadow_backfill_inflight_cancel_discards_reply_and_keeps_worker() {
        let f = Fixture::new();
        f.ready("Cancel in flight");
        let cfg = config(&f);
        let policy: Value =
            serde_json::from_str(include_str!("../../../character-runtime/s36_policy.json"))
                .unwrap();
        let pending = f
            .library
            .character_shadow_candidate("asset-5")
            .unwrap()
            .unwrap();
        let cache = f
            .temp
            .path()
            .join(".cache/characters/s36-augmentation-v1")
            .join(policy["feature_id"].as_str().unwrap());
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(
            cache.join(format!("{}.npz", pending.content_hash)),
            b"fixture protocol only",
        )
        .unwrap();
        let marker = f.temp.path().join("inflight");
        std::fs::write(&cfg.script, format!(r#"import sys, json, os
from pathlib import Path
print(json.dumps({{'type':'ready','baselineFingerprint':{baseline},'s36FeatureId':{identity},'pid':os.getpid()}}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if request['type'] == 's36_shadow':
        Path({marker}).write_text(str(os.getpid()))
    elif request['type'] == 's36_shadow_cancel':
        print(json.dumps({{'type':'s36_shadow_unavailable','reason':'preempted'}}), flush=True)
"#, baseline=json!(super::super::character_worker::BASELINE), identity=policy["feature_id"], marker=json!(marker))).unwrap();
        idle(&f, &cfg);
        f.library.character_shadow_backfill_start().unwrap();
        // Use only the cached fixture candidate, to enter the worker immediately.
        f.library.character_shadow_backfill.lock().unwrap().pending = VecDeque::from([pending]);
        let lib = f.library.clone();
        let worker_cfg = cfg.clone();
        let task = std::thread::spawn(move || {
            lib.advance_character_shadow_backfill(&worker_cfg, Arc::default())
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !marker.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(marker.exists());
        f.library.character_shadow_backfill_cancel();
        assert!(task.join().unwrap());
        assert!(f.library.character_shadow_backfill_status().cancelled);
        assert!(!f
            .temp
            .path()
            .join(".cache/characters/s36_shadow.sqlite")
            .exists());
        // A protocol-level cancel must leave the resident process reusable.
        let pid = f
            .library
            .character_worker_pool
            .with(&cfg, f.temp.path(), Arc::default(), false, |_, ready| {
                Ok(ready["pid"].clone())
            })
            .unwrap();
        assert_eq!(
            pid.as_u64().unwrap().to_string(),
            std::fs::read_to_string(&marker).unwrap()
        );
        f.library
            .connection()
            .unwrap()
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
    }
}
