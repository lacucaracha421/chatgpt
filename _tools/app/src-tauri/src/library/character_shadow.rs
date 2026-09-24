//! Disposable observations. Nothing in native classification reads this cache.
use super::{
    character_autotag::{Job, Prediction},
    characters::{Error, Result},
    Library,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};

#[derive(Debug, Deserialize)]
pub(super) struct Policy {
    pub version: String,
    pub feature_id: String,
    scorer: String,
    automatic_max_knn3: f64,
    recommendation_max_knn3: f64,
    automatic_min_prior_manual_rejections: u64,
}
impl Policy {
    pub(super) fn load(path: &Path, identity: &str) -> Result<Self> {
        let policy: Self = serde_json::from_slice(&std::fs::read(path)?)?;
        if policy.version.trim().is_empty()
            || policy.version.len() > 128
            || policy.scorer != "knn3"
            || !super::character_augmentation::is_hash(&json!(identity))
            || policy.feature_id != identity
            || !policy.automatic_max_knn3.is_finite()
            || !policy.recommendation_max_knn3.is_finite()
            || !(0.0..=1.0).contains(&policy.automatic_max_knn3)
            || !(policy.automatic_max_knn3..=1.0).contains(&policy.recommendation_max_knn3)
        {
            return Err(Error::Invalid(
                "S36 shadow policy or feature identity is invalid",
            ));
        }
        Ok(policy)
    }
    pub(super) fn verdict(&self, score: Option<f64>, rejections: u64) -> &'static str {
        match score.filter(|v| v.is_finite()) {
            None => "abstain",
            Some(v)
                if v <= self.automatic_max_knn3
                    && rejections >= self.automatic_min_prior_manual_rejections =>
            {
                "automatic"
            }
            Some(v) if v <= self.recommendation_max_knn3 => "recommended",
            _ => "none",
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct Pending {
    pub asset_id: String,
    pub content_hash: String,
    pub relative_path: String,
    pub outcomes: BTreeMap<String, String>,
    pub native_at: String,
}

/// Called inside the final native transaction, after its unchanged publication.
/// Only SELECTs; failure of observation must never roll back the native result.
pub(super) fn observe(c: &Connection, job: &Job, predictions: &[Prediction]) -> Result<Pending> {
    let mut outcomes = BTreeMap::new();
    for p in predictions {
        let decision: Option<(String, String)> = c.query_row(
            "SELECT decision,origin FROM character_decisions WHERE target_id=?1 AND source_asset_id=?2 AND asset_hash=?3 ORDER BY sequence DESC LIMIT 1",
            params![p.target_id, job.asset_id, job.content_hash], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let outcome = match decision {
            Some((d, origin)) if d == "accepted" => format!("accepted_{origin}"),
            Some((d, origin)) if origin == "manual" => format!("{d}_manual"),
            _ if p.result.state == "recommended" => "recommended".into(),
            _ => "none".into(),
        };
        outcomes.insert(p.target_id.clone(), outcome);
    }
    Ok(Pending {
        asset_id: job.asset_id.clone(),
        content_hash: job.content_hash.clone(),
        relative_path: job.relative_path.clone(),
        outcomes,
        native_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Export only metadata. All images supply duplicate-group bridges, but only
/// the evaluated roster supplies references/labels. No library SQL writes here.
pub(super) fn snapshot(c: &Connection, pending: &Pending) -> Result<(Value, u64)> {
    let ids = serde_json::to_string(&pending.outcomes.keys().collect::<Vec<_>>())?;
    let targets = c.prepare("SELECT id,series_classification_id,created_at FROM character_targets WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id")?
        .query_map([&ids], |r| Ok(json!({"id":r.get::<_,String>(0)?,"series_id":r.get::<_,Option<String>>(1)?,"created_at":r.get::<_,String>(2)?,"enabled":true})))?
        .collect::<std::result::Result<Vec<_>,_>>()?;
    if targets.len() != pending.outcomes.len() {
        return Err(Error::Stale);
    }
    let references = c.prepare("SELECT r.target_id,r.asset_hash,'anchor',NULL FROM character_references r JOIN assets a ON a.id=r.asset_id AND a.content_hash=r.asset_hash AND a.status='normal' AND a.media_kind='image' WHERE r.target_id IN (SELECT value FROM json_each(?1)) UNION ALL SELECT r.target_id,r.asset_hash,'learned',r.created_at FROM character_learned_references r JOIN assets a ON a.id=r.asset_id AND a.content_hash=r.asset_hash AND a.status='normal' AND a.media_kind='image' WHERE r.target_id IN (SELECT value FROM json_each(?1))")?
        .query_map([&ids], |r| Ok(json!({"target_id":r.get::<_,String>(0)?,"asset_hash":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"created_at":r.get::<_,Option<String>>(3)?})))?
        .collect::<std::result::Result<Vec<_>,_>>()?;
    let regions = c.prepare("SELECT target_id,asset_hash,baseline_fingerprint,bounds_json FROM character_reference_regions WHERE target_id IN (SELECT value FROM json_each(?1))")?
        .query_map([&ids], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?
        .collect::<std::result::Result<Vec<_>,_>>()?.into_iter().map(|(t,h,b,bounds)| Ok(json!({"target_id":t,"asset_hash":h,"baseline_fingerprint":b,"bounds":serde_json::from_str::<Value>(&bounds)?}))).collect::<Result<Vec<_>>>()?;
    let decisions = c.prepare("SELECT d.sequence,d.target_id,d.asset_hash,d.decision,d.created_at FROM character_decisions d JOIN assets a ON a.id=d.source_asset_id AND a.content_hash=d.asset_hash AND a.status='normal' AND a.media_kind='image' WHERE d.origin='manual' AND d.target_id IN (SELECT value FROM json_each(?1)) ORDER BY d.sequence")?
        .query_map([&ids], |r| Ok(json!({"sequence":r.get::<_,i64>(0)?,"target_id":r.get::<_,String>(1)?,"asset_hash":r.get::<_,String>(2)?,"decision":r.get::<_,String>(3)?,"created_at":r.get::<_,String>(4)?,"origin":"manual"})))?
        .collect::<std::result::Result<Vec<_>,_>>()?;
    let mut images: BTreeMap<String, Value> = BTreeMap::new();
    let mut statement =
        c.prepare("SELECT content_hash,perceptual_hash,source_url FROM assets ORDER BY id")?;
    let mut rows = statement.query([])?;
    while let Some(r) = rows.next()? {
        let Some(hash) = r.get::<_, Option<String>>(0)? else {
            continue;
        };
        if !super::character_augmentation::is_hash(&json!(hash)) {
            continue;
        }
        let image = images
            .entry(hash)
            .or_insert_with(|| json!({"pdq":[],"source_urls":[]}));
        if let Some(blob) = r.get::<_, Option<Vec<u8>>>(1)?.filter(|b| b.len() == 64) {
            let pdq: String = blob[..32].iter().map(|b| format!("{b:02x}")).collect();
            let array = image["pdq"].as_array_mut().unwrap();
            if !array.contains(&json!(pdq)) {
                array.push(json!(pdq));
            }
        }
        if let Some(url) = r.get::<_, Option<String>>(2)? {
            let array = image["source_urls"].as_array_mut().unwrap();
            if !array.contains(&json!(url)) {
                array.push(json!(url));
            }
        }
        if images.len() > 20000 {
            return Err(Error::Invalid("S36 shadow group metadata exceeds budget"));
        }
    }
    let rejections = c.query_row(
        "SELECT COUNT(*) FROM character_decisions WHERE origin='manual' AND decision='rejected'",
        [],
        |r| r.get::<_, i64>(0),
    )? as u64;
    Ok((
        json!({"targets":targets,"references":references,"regions":regions,"decisions":decisions,"images":images,"policy":super::character_augmentation::policy()}),
        rejections,
    ))
}

/// Recognize only the original schema and our origin upgrade, including keys.
/// Read-only callers use the returned flag to project legacy rows as live.
pub(super) fn cache_has_origin(c: &Connection) -> Result<bool> {
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let columns = c
        .prepare("PRAGMA table_info(scores)")?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, bool>(3)?,
                r.get::<_, i64>(5)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let names = [
        "asset_id",
        "content_hash",
        "target_id",
        "knn3",
        "verdict",
        "policy_version",
        "feature_id",
        "native_outcome",
        "native_at",
        "scored_at",
        "prior_manual_rejections",
        "origin",
    ];
    let origin = version == 1 && columns.len() == 12;
    if !(origin || version == 0 && columns.len() == 11)
        || columns
            .iter()
            .enumerate()
            .any(|(i, (name, kind, required, key))| {
                name != names[i]
                    || kind
                        != match i {
                            3 => "REAL",
                            10 => "INTEGER",
                            _ => "TEXT",
                        }
                    || *required != (i != 3)
                    || *key
                        != match i {
                            0 => 1,
                            2 => 2,
                            5 => 3,
                            _ => 0,
                        }
            })
    {
        return Err(Error::Invalid("Unknown S36 shadow cache schema"));
    }
    Ok(origin)
}

pub(super) struct Cache(Connection);
impl Cache {
    pub(super) fn open(root: &Path) -> Result<Self> {
        let mut path = root.to_path_buf();
        for part in [".cache", "characters", "s36_shadow.sqlite"] {
            path.push(part);
            if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err(Error::Invalid("Shadow cache must not contain symlinks"));
            }
        }
        std::fs::create_dir_all(path.parent().unwrap())?;
        let mut c = Connection::open(path)?;
        c.busy_timeout(std::time::Duration::from_millis(100))?;
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='scores')",
            [],
            |r| r.get(0),
        )?;
        if !exists {
            let version: i64 = tx.query_row("PRAGMA user_version", [], |r| r.get(0))?;
            let tables: i64 = tx.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get(0),
            )?;
            if version != 0 || tables != 0 {
                return Err(Error::Invalid("Unknown S36 shadow cache schema"));
            }
            tx.execute_batch(
                "CREATE TABLE scores (
            asset_id TEXT NOT NULL, content_hash TEXT NOT NULL, target_id TEXT NOT NULL,
            knn3 REAL, verdict TEXT NOT NULL, policy_version TEXT NOT NULL,
            feature_id TEXT NOT NULL, native_outcome TEXT NOT NULL,
            native_at TEXT NOT NULL, scored_at TEXT NOT NULL,
            prior_manual_rejections INTEGER NOT NULL,
            PRIMARY KEY(asset_id,target_id,policy_version))",
            )?;
        }
        if !cache_has_origin(&tx)? {
            tx.execute_batch("ALTER TABLE scores ADD COLUMN origin TEXT NOT NULL DEFAULT 'live'; PRAGMA user_version=1;")?;
        }
        tx.commit()?;
        Ok(Self(c))
    }
    pub(super) fn record(
        &mut self,
        pending: &Pending,
        policy: &Policy,
        response: &Value,
        rejections: u64,
        at: &str,
    ) -> Result<()> {
        self.record_origin(pending, policy, response, rejections, at, "live")
    }
    pub(super) fn record_origin(
        &mut self,
        pending: &Pending,
        policy: &Policy,
        response: &Value,
        rejections: u64,
        at: &str,
        origin: &str,
    ) -> Result<()> {
        if !matches!(origin, "live" | "backfill") {
            return Err(Error::Stale);
        }
        if response["type"] != "s36_shadow_result"
            || response["assetId"] != pending.asset_id
            || response["contentHash"] != pending.content_hash
            || response["featureId"] != policy.feature_id
        {
            return Err(Error::Stale);
        }
        let scores = response["scores"].as_object().ok_or(Error::Stale)?;
        if scores.keys().collect::<Vec<_>>() != pending.outcomes.keys().collect::<Vec<_>>() {
            return Err(Error::Stale);
        }
        let tx = self.0.transaction()?;
        for (target, value) in scores {
            let score = if value.is_null() {
                None
            } else {
                Some(
                    value
                        .as_f64()
                        .filter(|v| v.is_finite() && (-0.00001..=1.00001).contains(v))
                        .ok_or(Error::Stale)?,
                )
            };
            tx.execute("INSERT INTO scores(asset_id,content_hash,target_id,knn3,verdict,policy_version,feature_id,native_outcome,native_at,scored_at,prior_manual_rejections,origin) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
            ON CONFLICT(asset_id,target_id,policy_version) DO UPDATE SET content_hash=excluded.content_hash,knn3=excluded.knn3,verdict=excluded.verdict,feature_id=excluded.feature_id,native_outcome=excluded.native_outcome,native_at=excluded.native_at,scored_at=excluded.scored_at,prior_manual_rejections=excluded.prior_manual_rejections,origin=excluded.origin
            WHERE NOT (excluded.origin='backfill' AND scores.origin='live' AND julianday(scores.scored_at)>=julianday(excluded.scored_at))",
                params![pending.asset_id,pending.content_hash,target,score,policy.verdict(score,rejections),policy.version,policy.feature_id,pending.outcomes[target],pending.native_at,at,rejections as i64,origin])?;
        }
        tx.commit()?;
        Ok(())
    }
}

impl Library {
    pub(super) fn score_character_shadow(
        &self,
        pending: Pending,
        config: &super::character_worker::RuntimeConfig,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<()> {
        use std::io::Write;
        let cache = self.root.join(".cache/characters");
        let ready =
            self.character_worker_pool
                .with(config, &cache, stop.clone(), false, |_, ready| {
                    Ok(ready.clone())
                })?;
        let identity = ready["s36FeatureId"].as_str().ok_or(Error::Stale)?;
        let policy = Policy::load(&config.script.with_file_name("s36_policy.json"), identity)?;
        let source = super::character_sources::Source::capture(
            self,
            &pending.relative_path,
            &pending.content_hash,
        )?;
        let (snapshot, rejections, at) = {
            let mut c = self.connection()?;
            let tx = c.transaction()?;
            let (snapshot, rejections) = snapshot(&tx, &pending)?;
            (snapshot, rejections, chrono::Utc::now().to_rfc3339())
        };
        let mut file = tempfile::NamedTempFile::new()?;
        file.write_all(&serde_json::to_vec(&snapshot)?)?;
        file.flush()?;
        let response = self.character_worker_pool.with(config,&cache,stop.clone(),false,|worker,ready| {
            if ready["s36FeatureId"] != policy.feature_id || !self.augmentation_idle_allowed(&stop)? {return Ok(Value::Null);}
            worker.send(&json!({"type":"s36_shadow","assetId":pending.asset_id,"hash":pending.content_hash,"path":source.path(),"mediaKind":"image","snapshotPath":file.path(),"featureId":policy.feature_id,"targets":pending.outcomes.keys().collect::<Vec<_>>(),"scoredAt":at}))?;
            worker.receive_while(std::time::Duration::from_secs(120), || self.augmentation_idle_allowed(&stop))
        })?;
        // Policy/cache/protocol refusals do not discard the resident native
        // augmenter. Only transport failure follows the pool's recovery path.
        if !self.augmentation_idle_allowed(&stop)? {
            return Err(Error::Stale);
        }
        if response["type"] != "s36_shadow_result" {
            return Err(Error::Worker(format!(
                "S36 shadow unavailable: {}",
                response["reason"]
            )));
        }
        source.verify(self)?;
        Cache::open(&self.root)?.record(&pending, &policy, &response, rejections, &at)?;
        let published = self.publish_s36(&pending, &policy, &response, rejections, &config.s36)?;
        if published > 0 {
            eprintln!(
                "S36 automatic classification: {published} for {}",
                pending.asset_id
            );
        }
        Ok(())
    }

    /// Rollback: clear S36-made automatic acceptances of one series that nobody has
    /// judged since, through the ordinary manual decision path. B36 and manual
    /// decisions are never touched. Returns the number cleared.
    pub fn clear_s36_automatic(&self, series_id: &str) -> Result<u64> {
        let pairs = {
            let c = self.connection()?;
            let mut rows = c.prepare(
                "SELECT d.target_id,d.source_asset_id FROM character_decisions d
                 JOIN character_targets t ON t.id=d.target_id
                 WHERE t.series_classification_id=?1 AND d.origin='automatic' AND d.decision='accepted'
                   AND json_extract(d.reference_snapshot,'$.prediction.engine')='s36'
                   AND d.sequence=(SELECT MAX(x.sequence) FROM character_decisions x
                                   WHERE x.target_id=d.target_id AND x.source_asset_id=d.source_asset_id)
                 ORDER BY d.target_id,d.source_asset_id",
            )?;
            let found = rows
                .query_map([series_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
            for (target, asset) in found {
                grouped.entry(target).or_default().push(asset);
            }
            grouped
        };
        let mut cleared = 0;
        for (target_id, assets) in pairs {
            for chunk in assets.chunks(200) {
                let fingerprint = {
                    let c = self.connection()?;
                    self.read_character_target(&c, &target_id)?.fingerprint
                };
                cleared += self.record_character_decisions(super::characters::DecisionRequest {
                    target_id: target_id.clone(),
                    expected_fingerprint: fingerprint,
                    asset_ids: chunk.to_vec(),
                    decision: super::characters::DecisionKind::Cleared,
                    baseline_fingerprint: None,
                    scan_id: None,
                })?;
            }
        }
        Ok(cleared)
    }

    /// Stage 3. In a series switched to S36, an automatic verdict becomes an automatic
    /// acceptance. Any earlier decision for the pair (manual, automatic or cleared) wins,
    /// and scope, content and exclusion are rechecked in this write transaction.
    pub(super) fn publish_s36(
        &self,
        pending: &Pending,
        policy: &Policy,
        response: &Value,
        rejections: u64,
        s36: &super::character_worker::S36Publication,
    ) -> Result<usize> {
        if s36.s36_series.is_empty() {
            return Ok(0);
        }
        let scores = response["scores"].as_object().ok_or(Error::Stale)?;
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current: Option<String> = tx
            .query_row(
                "SELECT content_hash FROM assets WHERE id=?1 AND status='normal' AND media_kind='image'",
                [&pending.asset_id],
                |r| r.get(0),
            )
            .optional()?;
        if current.as_deref() != Some(pending.content_hash.as_str()) {
            return Ok(0);
        }
        let now = chrono::Utc::now().to_rfc3339();
        // One person is one character: among confident S36 targets, each person crop
        // keeps only its closest character. Excluded or already-judged characters still
        // take part, so they can block a look-alike, but only open pairs are written.
        let crops = response["crops"].as_object();
        let mut candidates = Vec::new();
        for target in self.character_autotag_targets(&tx, &pending.asset_id)? {
            if !s36.owns(target.series_classification_id.as_deref()) {
                continue;
            }
            let Some(score) = scores.get(&target.id).and_then(Value::as_f64) else {
                continue;
            };
            if policy.verdict(Some(score), rejections) != "automatic" {
                continue;
            }
            // Without crop information (older worker) all candidates share one person.
            let crop = crops
                .and_then(|c| c.get(&target.id))
                .and_then(Value::as_u64)
                .unwrap_or(u64::MAX);
            candidates.push((crop, score, target));
        }
        let mut winners: BTreeMap<u64, (f64, super::characters::Target)> = BTreeMap::new();
        for (crop, score, target) in candidates {
            if winners.get(&crop).is_none_or(|(best, _)| score < *best) {
                winners.insert(crop, (score, target));
            }
        }
        let mut published = 0;
        for (score, target) in winners.into_values() {
            if s36.s36_excluded_targets.contains(&target.id) {
                continue;
            }
            let earlier: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM character_decisions WHERE target_id=?1 AND source_asset_id=?2)",
                params![target.id, pending.asset_id],
                |r| r.get(0),
            )?;
            if earlier {
                continue;
            }
            let snapshot = json!({
                "scanId": null,
                "prediction": {
                    "engine": "s36",
                    "policyVersion": policy.version,
                    "featureId": policy.feature_id,
                    "knn3": score,
                    "priorManualRejections": rejections,
                    "automaticScope": true,
                },
                "references": target.usable_references().collect::<Vec<_>>(),
            });
            tx.execute(
                "INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
                 VALUES(?1,?2,?2,?3,'accepted',?4,?5,'automatic',?6)",
                params![target.id, pending.asset_id, pending.content_hash, target.fingerprint, serde_json::to_string(&snapshot)?, now],
            )?;
            published += 1;
        }
        if published > 0 {
            super::character_autotag::refresh_character_review_state(&tx, &pending.asset_id)?;
        }
        tx.commit()?;
        Ok(published)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy_file(root: &Path) -> std::path::PathBuf {
        let path = root.join("s36_policy.json");
        std::fs::write(
            &path,
            include_str!("../../../character-runtime/s36_policy.json"),
        )
        .unwrap();
        path
    }
    #[test]
    fn character_shadow_policy_validation_and_feature_binding() {
        let temp = tempfile::tempdir().unwrap();
        let path = policy_file(temp.path());
        let value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let id = value["feature_id"].as_str().unwrap();
        assert!(Policy::load(&path, id).is_ok());
        assert!(Policy::load(&path, &"f".repeat(64)).is_err());
        assert!(Policy::load(&temp.path().join("missing"), id).is_err());
        for (key, bad) in [
            ("version", json!("")),
            ("feature_id", json!("wrong")),
            ("scorer", json!("contrast")),
            ("automatic_max_knn3", json!(-1)),
            ("recommendation_max_knn3", json!(0)),
            ("automatic_min_prior_manual_rejections", json!(-1)),
            ("automatic_min_prior_manual_rejections", json!(2.5)),
        ] {
            let mut changed = value.clone();
            changed[key] = bad;
            std::fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
            assert!(Policy::load(&path, id).is_err(), "{key}");
        }
        std::fs::write(&path, b"{").unwrap();
        assert!(Policy::load(&path, id).is_err());
    }
    #[test]
    fn character_shadow_thresholds_guard_and_abstention() {
        let p = Policy {
            version: "v".into(),
            feature_id: "a".repeat(64),
            scorer: "knn3".into(),
            automatic_max_knn3: 0.13,
            recommendation_max_knn3: 0.15,
            automatic_min_prior_manual_rejections: 100,
        };
        assert_eq!(p.verdict(Some(0.13), 100), "automatic");
        assert_eq!(p.verdict(Some(0.13), 99), "recommended");
        assert_eq!(p.verdict(Some(0.15), 100), "recommended");
        assert_eq!(p.verdict(Some(0.150001), 100), "none");
        assert_eq!(p.verdict(None, 100), "abstain");
        assert_eq!(p.verdict(Some(f64::NAN), 100), "abstain");
    }
    #[test]
    fn character_shadow_cache_upsert_is_atomic_and_never_writes_library_db() {
        let f = super::super::characters::tests::Fixture::new();
        let target = f.ready("Shadow");
        let c = f.library.connection().unwrap();
        c.execute_batch("PRAGMA query_only=ON").unwrap();
        let changes = c.total_changes();
        let pending = Pending {
            asset_id: "asset-5".into(),
            content_hash: "a".repeat(64),
            relative_path: "unused".into(),
            outcomes: BTreeMap::from([(target.id.clone(), "none".into())]),
            native_at: "2026-09-23T00:00:00Z".into(),
        };
        let (snapshot, count) = snapshot(&c, &pending).unwrap();
        assert_eq!(snapshot["targets"][0]["id"], target.id);
        assert_eq!(count, 0);
        let p: Policy =
            serde_json::from_str(include_str!("../../../character-runtime/s36_policy.json"))
                .unwrap();
        let mut response = json!({"type":"s36_shadow_result","assetId":pending.asset_id,"contentHash":pending.content_hash,"featureId":p.feature_id,"scores":{target.id.clone():0.1}});
        let mut cache = Cache::open(f.temp.path()).unwrap();
        cache.record(&pending, &p, &response, 100, "first").unwrap();
        response["scores"][&target.id] = Value::Null;
        cache.record(&pending, &p, &response, 99, "second").unwrap();
        let row: (i64, String, String) = cache
            .0
            .query_row("SELECT COUNT(*),verdict,scored_at FROM scores", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(row, (1, "abstain".into(), "second".into()));
        response["scores"]["foreign"] = json!(0.1);
        assert!(cache.record(&pending, &p, &response, 100, "bad").is_err());
        assert_eq!(c.total_changes(), changes);
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='scores'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        c.execute_batch("PRAGMA query_only=OFF").unwrap();
    }
    #[test]
    fn character_shadow_origin_upgrade_refuses_unknown_schema() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(".cache/characters/s36_shadow.sqlite");
        let cache = Cache::open(temp.path()).unwrap();
        cache
            .0
            .execute_batch("ALTER TABLE scores DROP COLUMN origin; PRAGMA user_version=0;")
            .unwrap();
        drop(cache);
        let legacy = Connection::open(&path).unwrap();
        legacy.execute("INSERT INTO scores VALUES('a','hash','t',0.1,'automatic','v','f','none','n','s',100)", []).unwrap();
        assert!(!cache_has_origin(&legacy).unwrap());
        drop(legacy);
        let upgraded = Cache::open(temp.path()).unwrap();
        assert!(cache_has_origin(&upgraded.0).unwrap());
        assert_eq!(
            upgraded
                .0
                .query_row("SELECT origin FROM scores", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "live"
        );
        upgraded.0.execute_batch("PRAGMA user_version=2").unwrap();
        assert!(Cache::open(temp.path()).is_err());
        upgraded
            .0
            .execute_batch("PRAGMA user_version=1; ALTER TABLE scores ADD COLUMN future TEXT;")
            .unwrap();
        assert!(Cache::open(temp.path()).is_err());
    }

    #[test]
    fn character_shadow_backfill_cannot_replace_newer_live_row() {
        let temp = tempfile::tempdir().unwrap();
        let policy: Policy =
            serde_json::from_str(include_str!("../../../character-runtime/s36_policy.json"))
                .unwrap();
        let pending = Pending {
            asset_id: "a".into(),
            content_hash: "a".repeat(64),
            relative_path: "unused".into(),
            outcomes: BTreeMap::from([("t".into(), "none".into())]),
            native_at: "2026-01-01T00:00:00Z".into(),
        };
        let response = json!({"type":"s36_shadow_result","assetId":"a","contentHash":pending.content_hash,"featureId":policy.feature_id,"scores":{"t":0.1}});
        let mut cache = Cache::open(temp.path()).unwrap();
        cache
            .record(&pending, &policy, &response, 100, "2026-01-02T00:00:00Z")
            .unwrap();
        cache
            .record_origin(
                &pending,
                &policy,
                &response,
                0,
                "2026-01-01T00:00:00Z",
                "backfill",
            )
            .unwrap();
        assert_eq!(
            cache
                .0
                .query_row("SELECT origin,verdict FROM scores", [], |r| Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?
                )))
                .unwrap(),
            ("live".into(), "automatic".into())
        );
        cache
            .record_origin(
                &pending,
                &policy,
                &response,
                0,
                "2026-01-03T00:00:00Z",
                "backfill",
            )
            .unwrap();
        assert_eq!(
            cache
                .0
                .query_row("SELECT origin,verdict FROM scores", [], |r| Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?
                )))
                .unwrap(),
            ("backfill".into(), "recommended".into())
        );
    }
    fn s36_fixture() -> (
        super::super::characters::tests::Fixture,
        super::super::characters::Target,
        Policy,
        Pending,
    ) {
        let f = super::super::characters::tests::Fixture::new();
        let target = f.ready("S36");
        let policy = Policy {
            version: "s36-knn3-v2".into(),
            feature_id: "a".repeat(64),
            scorer: "knn3".into(),
            automatic_max_knn3: 0.1085,
            recommendation_max_knn3: 0.12,
            automatic_min_prior_manual_rejections: 100,
        };
        let hash: String = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT content_hash FROM assets WHERE id='asset-5'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let pending = Pending {
            asset_id: "asset-5".into(),
            content_hash: hash,
            relative_path: String::new(),
            outcomes: BTreeMap::from([(target.id.clone(), "none".into())]),
            native_at: "2026-09-24T00:00:00Z".into(),
        };
        (f, target, policy, pending)
    }
    fn response(pending: &Pending, target: &str, score: f64) -> Value {
        json!({"type":"s36_shadow_result","assetId":pending.asset_id,"contentHash":pending.content_hash,
               "featureId":"a".repeat(64),"queryAvailable":true,"scores":{target: score}})
    }
    #[test]
    fn s36_publication_accepts_only_confident_unjudged_pairs_in_s36_series_and_rolls_back() {
        let (f, target, policy, pending) = s36_fixture();
        let mut s36 = super::super::character_worker::S36Publication::default();
        let confident = response(&pending, &target.id, 0.05);
        // Not an S36 series: nothing is published.
        assert_eq!(
            f.library
                .publish_s36(&pending, &policy, &confident, 100, &s36)
                .unwrap(),
            0
        );
        s36.s36_series.insert(f.series.clone());
        // Below the guard or above the threshold: nothing is published.
        assert_eq!(
            f.library
                .publish_s36(&pending, &policy, &confident, 99, &s36)
                .unwrap(),
            0
        );
        let unsure = response(&pending, &target.id, 0.11);
        assert_eq!(
            f.library
                .publish_s36(&pending, &policy, &unsure, 100, &s36)
                .unwrap(),
            0
        );
        // Excluded character: nothing is published.
        s36.s36_excluded_targets.insert(target.id.clone());
        assert_eq!(
            f.library
                .publish_s36(&pending, &policy, &confident, 100, &s36)
                .unwrap(),
            0
        );
        s36.s36_excluded_targets.clear();
        assert_eq!(
            f.library
                .publish_s36(&pending, &policy, &confident, 100, &s36)
                .unwrap(),
            1
        );
        let (origin, engine): (String, String) = f.library.connection().unwrap().query_row(
            "SELECT origin,json_extract(reference_snapshot,'$.prediction.engine') FROM character_decisions WHERE target_id=?1 AND source_asset_id='asset-5' ORDER BY sequence DESC LIMIT 1",
            [&target.id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((origin.as_str(), engine.as_str()), ("automatic", "s36"));
        assert_eq!(
            f.library.character_relations_for_asset("asset-5").unwrap(),
            vec![target.id.clone()]
        );
        // An earlier decision always wins; publishing again changes nothing.
        assert_eq!(
            f.library
                .publish_s36(&pending, &policy, &confident, 100, &s36)
                .unwrap(),
            0
        );
        // Rollback clears it through the manual path, and S36 does not re-add it.
        assert_eq!(f.library.clear_s36_automatic(&f.series).unwrap(), 1);
        assert!(f
            .library
            .character_relations_for_asset("asset-5")
            .unwrap()
            .is_empty());
        assert_eq!(f.library.clear_s36_automatic(&f.series).unwrap(), 0);
        assert_eq!(
            f.library
                .publish_s36(&pending, &policy, &confident, 100, &s36)
                .unwrap(),
            0
        );
    }
    #[test]
    fn s36_publication_skips_changed_content() {
        let (f, target, policy, mut pending) = s36_fixture();
        let mut s36 = super::super::character_worker::S36Publication::default();
        s36.s36_series.insert(f.series.clone());
        pending.content_hash = "b".repeat(64);
        let confident = response(&pending, &target.id, 0.05);
        assert_eq!(
            f.library
                .publish_s36(&pending, &policy, &confident, 100, &s36)
                .unwrap(),
            0
        );
    }
    #[test]
    fn s36_publication_gives_one_person_crop_only_its_closest_character() {
        let (f, target, policy, mut pending) = s36_fixture();
        let other = f.ready("Look-alike");
        pending.outcomes.insert(other.id.clone(), "none".into());
        let mut s36 = super::super::character_worker::S36Publication::default();
        s36.s36_series.insert(f.series.clone());
        let same = json!({"type":"s36_shadow_result","assetId":pending.asset_id,"contentHash":pending.content_hash,
            "featureId":"a".repeat(64),"queryAvailable":true,
            "scores":{target.id.clone(): 0.05, other.id.clone(): 0.10},
            "crops":{target.id.clone(): 0, other.id.clone(): 0}});
        assert_eq!(
            f.library
                .publish_s36(&pending, &policy, &same, 100, &s36)
                .unwrap(),
            1
        );
        assert_eq!(
            f.library.character_relations_for_asset("asset-5").unwrap(),
            vec![target.id.clone()]
        );
    }
    #[test]
    fn s36_publication_accepts_two_characters_on_two_people_and_excluded_still_blocks() {
        let (f, target, policy, mut pending) = s36_fixture();
        let other = f.ready("Second");
        pending.outcomes.insert(other.id.clone(), "none".into());
        let mut s36 = super::super::character_worker::S36Publication::default();
        s36.s36_series.insert(f.series.clone());
        s36.s36_excluded_targets.insert(target.id.clone());
        let same = json!({"type":"s36_shadow_result","assetId":pending.asset_id,"contentHash":pending.content_hash,
            "featureId":"a".repeat(64),"queryAvailable":true,
            "scores":{target.id.clone(): 0.05, other.id.clone(): 0.10},
            "crops":{target.id.clone(): 0, other.id.clone(): 0}});
        // The excluded closer character blocks the look-alike on the same person.
        assert_eq!(
            f.library
                .publish_s36(&pending, &policy, &same, 100, &s36)
                .unwrap(),
            0
        );
        s36.s36_excluded_targets.clear();
        let two = json!({"type":"s36_shadow_result","assetId":pending.asset_id,"contentHash":pending.content_hash,
            "featureId":"a".repeat(64),"queryAvailable":true,
            "scores":{target.id.clone(): 0.05, other.id.clone(): 0.10},
            "crops":{target.id.clone(): 0, other.id.clone(): 1}});
        assert_eq!(
            f.library
                .publish_s36(&pending, &policy, &two, 100, &s36)
                .unwrap(),
            2
        );
    }
}
