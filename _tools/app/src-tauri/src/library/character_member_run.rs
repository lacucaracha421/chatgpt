//! Durable, image-level identification. Pairwise judging remains independent.
use super::member_probe::{self as probe, Answer, Sample, Usage};
use super::*;

const CUTOFF: (i32, u32, u32) = (2026, 10, 26);

fn ongoing_on(mode: &str, date: chrono::NaiveDate) -> bool {
    mode == "on" || (mode == "until" && (date.year(), date.month(), date.day()) <= CUTOFF)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberStatus {
    pub state: String,
    pub plan_id: Option<String>,
    pub buckets: [usize; 3],
    pub estimate_low_usd: f64,
    pub estimate_high_usd: f64,
    pub total: usize,
    pub done: usize,
    pub failed: usize,
    pub cap_usd: f64,
    pub spent_usd: f64,
    pub reserved_usd: f64,
    pub remaining_usd: f64,
    pub ongoing_enabled: bool,
    pub ongoing_until_cutoff: bool,
}

pub(super) fn monthly_spend(c: &Connection, since: &str) -> Result<f64> {
    Ok(c.query_row("SELECT COALESCE(SUM(COALESCE(r.actual_usd,r.reserved_usd)),0) FROM character_member_requests r JOIN character_member_items i ON i.id=r.item_id WHERE i.mode='ongoing' AND r.created_at>=?1", [since], |r| r.get(0))?)
}

fn bucket(n: usize) -> usize {
    if n <= 5 {
        0
    } else if n <= 15 {
        1
    } else {
        2
    }
}

// At most eleven resized images. Reserve every image at the 1568-square upper
// bound, every text byte as a token, plus framing and the full output allowance.
// This includes cache creation at 1.25x; typical Sonnet reservation is ~$0.12.
fn reservation(sample: &Sample, model: &str) -> f64 {
    let pictures = 1 + sample
        .candidates
        .iter()
        .map(|c| c.references.len())
        .sum::<usize>();
    let text = sample.series_name.len()
        + sample
            .candidates
            .iter()
            .map(|c| c.name.len())
            .sum::<usize>();
    let input =
        pictures as u32 * ((MAX_IMAGE_EDGE * MAX_IMAGE_EDGE + 749) / 750) + text as u32 + 4096;
    cost_usd(model, 0, 2000, input, 0)
}

fn automatic(sample: &Sample, confidence: f64) -> bool {
    sample.member_count <= 5 && confidence >= SONNET_ACCEPT_CONFIDENCE
}

// This predicate is checked again inside the write transaction. Any hand decision
// wins, including a rejection/clear of an unrelated member while a request is away.
fn eligible(c: &Connection, sample: &Sample) -> Result<bool> {
    Ok(c.query_row(&format!("WITH RECURSIVE scope(id) AS (SELECT ?3 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id), {EXCLUDED_TREE}
      SELECT EXISTS(SELECT 1 FROM assets a WHERE a.id=?1 AND a.content_hash=?2 AND a.status='normal' AND a.media_kind='image'
        AND EXISTS(SELECT 1 FROM asset_classifications ac JOIN scope s ON s.id=ac.classification_id WHERE ac.asset_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM asset_classifications ac JOIN excluded x ON x.id=ac.classification_id WHERE ac.asset_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM character_decisions d WHERE d.source_asset_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM asset_classifications ac JOIN character_targets t ON t.linked_classification_id=ac.classification_id WHERE ac.asset_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.asset_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM character_tagger_pending p WHERE p.asset_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM character_member_pending p WHERE p.asset_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM character_autotag_evidence e JOIN character_autotag_predictions p ON p.evidence_id=e.id WHERE e.asset_id=a.id AND json_extract(p.result_json,'$.state')='recommended'))
        AND (SELECT COUNT(*) FROM character_targets WHERE enabled=1 AND role='character' AND series_classification_id=?3)=?4"),
      params![sample.image.id,sample.image.hash,sample.series,sample.member_count as i64], |r| r.get(0))?)
}

/// Folders whose images are never analysed (library data, so ids are never hard-coded here).
/// An image is excluded when it sits in a listed folder or anywhere below one.
const EXCLUDED_TREE: &str = "excluded(id) AS (SELECT classification_id FROM character_member_excluded_folders UNION SELECT c.id FROM classification_entries c JOIN excluded e ON c.parent_id=e.id)";
/// First-run default: these children of the root "기타" are not character material.
const SEED_PARENT: &str = "기타";
const SEED_FOLDERS: [&str; 10] = [
    "실사",
    "애니메이션",
    "공부자료",
    "밈",
    "유용함",
    "디자인",
    "번역",
    "기록",
    "망가표지",
    "ai",
];
const MAX_EXCLUDED_FOLDERS: usize = 500;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedFolder {
    pub id: String,
    pub path: String,
}

/// Which of these assets sit in an analysis-excluded folder (or below one).
pub(super) fn excluded_assets(c: &Connection, asset_ids: &[String]) -> Result<BTreeSet<String>> {
    if asset_ids.is_empty() {
        return Ok(BTreeSet::new());
    }
    let mut statement = c.prepare(&format!("WITH RECURSIVE {EXCLUDED_TREE}
      SELECT DISTINCT ac.asset_id FROM asset_classifications ac JOIN excluded x ON x.id=ac.classification_id
      WHERE ac.asset_id IN (SELECT value FROM json_each(?1))"))?;
    let rows = statement.query_map([serde_json::to_string(asset_ids)?], |r| {
        r.get::<_, String>(0)
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn seed_exclusions(c: &Connection) -> Result<()> {
    if c.query_row(
        "SELECT seeded FROM character_member_exclusion_state WHERE singleton=1",
        [],
        |r| r.get::<_, bool>(0),
    )? {
        return Ok(());
    }
    c.execute(
        "INSERT OR IGNORE INTO character_member_excluded_folders(classification_id)
      SELECT c.id FROM classification_entries c JOIN classification_entries p ON p.id=c.parent_id
      WHERE p.kind='root' AND p.name=?1 AND c.name IN (SELECT value FROM json_each(?2))",
        params![SEED_PARENT, serde_json::to_string(&SEED_FOLDERS)?],
    )?;
    c.execute(
        "UPDATE character_member_exclusion_state SET seeded=1 WHERE singleton=1",
        [],
    )?;
    Ok(())
}

fn excluded_folders_in(c: &Connection) -> Result<Vec<ExcludedFolder>> {
    let ids = c
        .prepare("SELECT classification_id FROM character_member_excluded_folders")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut folders = Vec::new();
    for id in ids {
        let names = c
            .prepare("WITH RECURSIVE up(id,name,parent_id,depth) AS (SELECT id,name,parent_id,0 FROM classification_entries WHERE id=?1
              UNION ALL SELECT c.id,c.name,c.parent_id,u.depth+1 FROM classification_entries c JOIN up u ON c.id=u.parent_id)
              SELECT name FROM up ORDER BY depth DESC")?
            .query_map([&id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        folders.push(ExcludedFolder {
            id,
            path: names.join(" › "),
        });
    }
    folders.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(folders)
}

impl Library {
    pub fn member_recommendations(
        &self,
    ) -> Result<Vec<super::super::character_shadow_review::ShadowReviewItem>> {
        let rows=self.connection()?.prepare("SELECT p.asset_id,p.asset_hash,p.target_id,a.original_name,a.width,a.height FROM character_member_pending p JOIN assets a ON a.id=p.asset_id ORDER BY p.target_id,p.asset_id")?
            .query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,u32>(4)?,r.get::<_,u32>(5)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let ids = rows
            .iter()
            .map(|r| r.2.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let targets = self
            .character_targets_unlocked(&ids)?
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect::<BTreeMap<_, _>>();
        Ok(rows
            .into_iter()
            .filter_map(
                |(asset_id, content_hash, id, original_name, width, height)| {
                    let t = targets.get(&id)?;
                    Some(super::super::character_shadow_review::ShadowReviewItem {
                        asset_id,
                        content_hash,
                        original_name,
                        width,
                        height,
                        target_id: id,
                        target_name: t.display_name.clone(),
                        target_fingerprint: t.fingerprint.clone(),
                        reference_asset_ids: t
                            .references
                            .iter()
                            .filter(|r| r.status == "ready")
                            .take(2)
                            .filter_map(|r| r.asset_id.clone())
                            .collect(),
                        verdict: "recommended".into(),
                        origin: "claude".into(),
                        knn3: None,
                        native_outcome: "none".into(),
                        scored_at: String::new(),
                        folded: false,
                    })
                },
            )
            .collect())
    }

    /// Fills the exclusion list once, the first time the "기타" root exists. Later edits
    /// (including emptying the list) set the flag too, so they are never overwritten.
    pub(super) fn member_exclusions_seed(&self) -> Result<()> {
        let mut c = self.connection()?;
        let settled: bool = c.query_row(
            "SELECT seeded OR NOT EXISTS(SELECT 1 FROM classification_entries WHERE kind='root' AND name=?1) FROM character_member_exclusion_state WHERE singleton=1",
            [SEED_PARENT],
            |r| r.get(0),
        )?;
        if settled {
            return Ok(());
        }
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        seed_exclusions(&tx)?;
        tx.commit()?;
        Ok(())
    }

    pub fn member_excluded_folders(&self) -> Result<Vec<ExcludedFolder>> {
        self.member_exclusions_seed()?;
        excluded_folders_in(&*self.connection()?)
    }

    pub fn set_member_excluded_folders(&self, ids: &[String]) -> Result<Vec<ExcludedFolder>> {
        let ids = ids.iter().collect::<BTreeSet<_>>();
        if ids.len() > MAX_EXCLUDED_FOLDERS {
            return Err(Error::Invalid("제외할 폴더가 너무 많습니다."));
        }
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM character_member_excluded_folders", [])?;
        for id in ids {
            let found = tx.execute(
                "INSERT INTO character_member_excluded_folders(classification_id) SELECT id FROM classification_entries WHERE id=?1",
                [id],
            )?;
            if found == 0 {
                return Err(Error::NotFound);
            }
        }
        tx.execute(
            "UPDATE character_member_exclusion_state SET seeded=1 WHERE singleton=1",
            [],
        )?;
        let folders = excluded_folders_in(&tx)?;
        tx.commit()?;
        Ok(folders)
    }

    pub fn member_status(&self) -> Result<MemberStatus> {
        let c = self.connection()?;
        let (state,plan_id,cap,mode): (String,Option<String>,f64,String) = c.query_row("SELECT state,plan_id,cap_usd,ongoing_mode FROM character_member_control WHERE singleton=1",[],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        let rows = c.prepare("SELECT CASE WHEN json_extract(sample_json,'$.member_count')<=5 THEN 0 WHEN json_extract(sample_json,'$.member_count')<=15 THEN 1 ELSE 2 END,COUNT(*),SUM(state<>'pending'),SUM(state='error') FROM character_member_items WHERE mode='backlog' GROUP BY 1")?
            .query_map([],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut buckets = [0; 3];
        let mut done = 0;
        let mut failed = 0;
        for (bucket, total, completed, errors) in rows {
            buckets[bucket as usize] = total as usize;
            done += completed as usize;
            failed += errors as usize;
        }
        let (spent,reserved): (f64,f64) = c.query_row("SELECT COALESCE(SUM(r.actual_usd),0),COALESCE(SUM(CASE WHEN r.actual_usd IS NULL THEN r.reserved_usd ELSE 0 END),0) FROM character_member_requests r JOIN character_member_items i ON i.id=r.item_id WHERE i.mode='backlog'",[],|r| Ok((r.get(0)?,r.get(1)?)))?;
        let total = buckets.iter().sum();
        // Measured Sonnet 1.6–4.7 cents; larger-series cascade adds Haiku
        // 0.1–0.25 cents and may finish without Sonnet.
        let large = (buckets[1] + buckets[2]) as f64;
        Ok(MemberStatus {
            state,
            plan_id,
            buckets,
            estimate_low_usd: buckets[0] as f64 * 0.016 + large * 0.001,
            estimate_high_usd: buckets[0] as f64 * 0.047 + large * 0.0495,
            total,
            done,
            failed,
            cap_usd: cap,
            spent_usd: spent,
            reserved_usd: reserved,
            remaining_usd: (cap - spent - reserved).max(0.0),
            ongoing_enabled: ongoing_on(&mode, Local::now().date_naive()),
            ongoing_until_cutoff: mode == "until",
        })
    }

    /// Freeze the cohort before the user sees its count. Confirming this plan never
    /// adds later arrivals. Read-only experiment code supplies exactly the same candidates.
    pub fn member_plan(&self) -> Result<MemberStatus> {
        let current = self.member_status()?;
        if !matches!(current.state.as_str(), "idle" | "draft") {
            return Err(Error::Invalid("이미 분석 실행이 있습니다."));
        }
        self.member_exclusions_seed()?;
        let manifest = probe::build_pool(&self.canonical_root, true)
            .map_err(|e| Error::Worker(e.to_string()))?;
        let mut samples = manifest.samples;
        samples.sort_by_key(|s| {
            (
                bucket(s.member_count),
                s.series.clone(),
                s.candidates
                    .iter()
                    .map(|c| c.id.clone())
                    .collect::<Vec<_>>(),
                s.image.id.clone(),
            )
        });
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state: String = tx.query_row(
            "SELECT state FROM character_member_control WHERE singleton=1",
            [],
            |r| r.get(0),
        )?;
        if !matches!(state.as_str(), "idle" | "draft") {
            return Err(Error::Invalid("이미 분석 실행이 있습니다."));
        }
        // A draft is only replaced by an explicit preview, never by a background turn.
        tx.execute(
            "DELETE FROM character_member_items WHERE mode='backlog'",
            [],
        )?;
        for sample in samples {
            if eligible(&tx, &sample)? {
                tx.execute("INSERT OR IGNORE INTO character_member_items(mode,asset_id,sample_json) VALUES('backlog',?1,?2)",params![sample.image.id,serde_json::to_string(&sample)?])?;
            }
        }
        tx.execute(
            "UPDATE character_member_control SET state='draft',plan_id=?1 WHERE singleton=1",
            [uuid::Uuid::new_v4().to_string()],
        )?;
        tx.commit()?;
        drop(c);
        self.member_status()
    }

    pub fn member_control(
        &self,
        action: &str,
        cap_usd: Option<f64>,
        plan_id: Option<&str>,
        ongoing_enabled: Option<bool>,
    ) -> Result<MemberStatus> {
        if cap_usd.is_some_and(|v| !v.is_finite() || !(0.0..=100_000.0).contains(&v)) {
            return Err(Error::Invalid("분석 한도가 올바르지 않습니다."));
        }
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (state, plan): (String, Option<String>) = tx.query_row(
            "SELECT state,plan_id FROM character_member_control WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let next = match action {
            "settings" => state.as_str(),
            "start" if state == "draft" && plan_id.is_some() && plan_id == plan.as_deref() => {
                "running"
            }
            "pause" if state == "running" => "paused",
            "resume"
                if matches!(
                    state.as_str(),
                    "paused" | "capped" | "error" | "no_key" | "credential"
                ) =>
            {
                "running"
            }
            "cancel" if !matches!(state.as_str(), "idle" | "completed" | "cancelled") => {
                "cancelled"
            }
            _ => {
                return Err(Error::Invalid(
                    "분석 상태가 바뀌었습니다. 다시 확인해 주세요.",
                ))
            }
        };
        tx.execute("UPDATE character_member_control SET state=?1,cap_usd=COALESCE(?2,cap_usd),ongoing_mode=CASE WHEN ?3 IS NULL THEN ongoing_mode WHEN ?3 THEN ?4 ELSE 'off' END WHERE singleton=1",params![next,cap_usd,ongoing_enabled,if ongoing_on("until",Local::now().date_naive()) {"until"} else {"on"}])?;
        tx.commit()?;
        drop(c);
        if matches!(next, "paused" | "cancelled") {
            crate::activities::finish("character-members", None);
        }
        self.character_wake.notify();
        self.member_status()
    }

    pub(in crate::library) fn advance_character_members(&self, stop: &AtomicBool) -> bool {
        if crate::workload::is_restricted()
            || !self.augmentation_idle_allowed(stop).unwrap_or(false)
        {
            return false;
        }
        let key = || {
            super::super::credential::read_claude_key_os()
                .ok()
                .flatten()
                .map(|c| c.api_key.clone())
        };
        match self.member_turn(stop, http_transport(), &key) {
            Ok(progress) => progress,
            Err(e) => {
                eprintln!("캐릭터 멤버 분석: {e}");
                let _ = self.connection().and_then(|c| {
                    Ok(c.execute(
                        "UPDATE character_member_control SET state='error' WHERE state='running'",
                        [],
                    )?)
                });
                crate::activities::finish(
                    "character-members",
                    Some("분석을 계속하려면 다시 시작하세요".into()),
                );
                false
            }
        }
    }

    pub(super) fn member_turn(
        &self,
        stop: &AtomicBool,
        transport: &dyn Transport,
        read_key: &dyn Fn() -> Option<String>,
    ) -> Result<bool> {
        if stop.load(Ordering::Acquire) || crate::workload::is_restricted() {
            return Ok(false);
        }
        let status = self.member_status()?;
        let mode = if status.state == "running" {
            "backlog"
        } else if status.ongoing_enabled {
            "ongoing"
        } else {
            return Ok(false);
        };
        let Some(key) = read_key() else {
            if mode == "backlog" {
                self.member_set_state("no_key")?;
            }
            return Ok(false);
        };
        self.member_exclusions_seed()?;
        let item = self.member_next(mode)?;
        let Some((id, sample)) = item else {
            if mode == "backlog" {
                self.member_set_state("completed")?;
            }
            crate::activities::finish("character-members", None);
            return Ok(false);
        };
        if !eligible(&*self.connection()?, &sample)? {
            self.member_item_done(id, "skipped")?;
            return Ok(true);
        }
        let (done, total) = if mode == "backlog" {
            (status.done, status.total)
        } else {
            self.connection()?.query_row("SELECT COALESCE(SUM(state<>'pending'),0),COUNT(*) FROM character_member_items WHERE mode='ongoing'",[],|r|Ok((r.get::<_,i64>(0)? as usize,r.get::<_,i64>(1)? as usize)))?
        };
        crate::activities::report(
            "character-members",
            "character_claude",
            if mode == "backlog" {
                "미분류 캐릭터 분석"
            } else {
                "새 이미지 캐릭터 분석"
            },
            "running",
            done as u64,
            Some(total as u64),
            None,
            Some("character"),
            Some(sample.series_name.clone()),
            None,
        );
        let first = if sample.member_count <= 5 {
            SONNET
        } else {
            HAIKU
        };
        let mut model = first;
        loop {
            // Reuse a settled answer after restart; an ambiguous reservation is never sent twice.
            let stored:Option<(Option<String>,Option<f64>)>=self.connection()?.query_row("SELECT answer_json,actual_usd FROM character_member_requests WHERE item_id=?1 AND model=?2",params![id,model],|r| Ok((r.get(0)?,r.get(1)?))).optional()?;
            let answer = if let Some((answer, actual)) = stored {
                match (answer, actual) {
                    (Some(a), Some(_)) => serde_json::from_str::<Answer>(&a)?,
                    _ => {
                        self.member_item_done(id, "error")?;
                        return Ok(true);
                    }
                }
            } else {
                if stop.load(Ordering::Acquire)
                    || crate::workload::is_restricted()
                    || !self.augmentation_idle_allowed(stop)?
                {
                    return Ok(false);
                }
                let body = match probe::body(&self.canonical_root, &sample, model) {
                    Ok(b) => serde_json::to_vec(&b)?,
                    Err(_) => {
                        self.member_item_done(id, "error")?;
                        return Ok(true);
                    }
                };
                if stop.load(Ordering::Acquire)
                    || crate::workload::is_restricted()
                    || !self.augmentation_idle_allowed(stop)?
                {
                    return Ok(false);
                }
                if !self.member_reserve(id, mode, &sample, model)? {
                    return Ok(false);
                }
                // No transparent retries: a lost response may still be billed.
                let reply = transport.post(&key, &body);
                let (usage, answer) = match reply {
                    Ok(reply) if reply.status == 200 => {
                        let value: Value = serde_json::from_str(&reply.body).unwrap_or(Value::Null);
                        (
                            Usage::parse(&value["usage"]).ok(),
                            probe::parse_answer(&value, &sample).ok(),
                        )
                    }
                    Ok(reply) => {
                        self.member_set_state(if reply.status == 401 || reply.status == 403 {
                            "credential"
                        } else {
                            "error"
                        })?;
                        (None, None)
                    }
                    Err(()) => {
                        self.member_set_state("error")?;
                        (None, None)
                    }
                };
                let c = self.connection()?;
                c.execute("UPDATE character_member_requests SET actual_usd=?3,usage_json=?4,answer_json=?5 WHERE item_id=?1 AND model=?2",params![id,model,usage.map(|u|u.cost(model)),usage.map(|u|serde_json::to_string(&u)).transpose()?,answer.as_ref().map(serde_json::to_string).transpose()?])?;
                drop(c);
                let Some(answer) = answer.filter(|_| usage.is_some()) else {
                    self.member_item_done(id, "error")?;
                    return Ok(true);
                };
                answer
            };
            if model == HAIKU && answer.present.is_empty() {
                model = SONNET;
                continue;
            }
            self.member_apply(id, &sample, &answer, model, mode)?;
            crate::activities::progress(
                "character-members",
                (done + 1) as u64,
                Some(total as u64),
                None,
            );
            return Ok(true);
        }
    }

    fn member_set_state(&self, state: &str) -> Result<()> {
        self.connection()?.execute(
            "UPDATE character_member_control SET state=?1 WHERE singleton=1 AND state='running'",
            [state],
        )?;
        Ok(())
    }
    fn member_item_done(&self, id: i64, state: &str) -> Result<()> {
        self.connection()?.execute(
            "UPDATE character_member_items SET state=?2 WHERE id=?1",
            params![id, state],
        )?;
        Ok(())
    }

    fn member_next(&self, mode: &str) -> Result<Option<(i64, Sample)>> {
        let read = || -> Result<Option<(i64, Sample)>> {
            let row:Option<(i64,String)>=self.connection()?.query_row("SELECT id,sample_json FROM character_member_items WHERE mode=?1 AND state='pending' ORDER BY id LIMIT 1",[mode],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            row.map(|(id, s)| Ok((id, serde_json::from_str(&s)?)))
                .transpose()
        };
        let next = read()?;
        if next.is_some() || mode == "backlog" {
            return Ok(next);
        }
        {
            let mut state = self.claude_state();
            if state
                .member_discovered_at
                .is_some_and(|at| at.elapsed() < Duration::from_secs(60))
            {
                return Ok(None);
            }
            state.member_discovered_at = Some(Instant::now());
        }
        let manifest = probe::build_pool(&self.canonical_root, true)
            .map_err(|e| Error::Worker(e.to_string()))?;
        let c = self.connection()?;
        let after: String = c.query_row(
            "SELECT arrival_after FROM character_member_control WHERE singleton=1",
            [],
            |r| r.get(0),
        )?;
        let mut samples = manifest.samples;
        samples.sort_by_key(|s| (bucket(s.member_count), s.series.clone(), s.image.id.clone()));
        for s in samples {
            let fresh: bool = c.query_row(
                "SELECT julianday(collected_at)>julianday(?2) FROM assets WHERE id=?1",
                params![s.image.id, after],
                |r| r.get(0),
            )?;
            if fresh && eligible(&c, &s)? {
                c.execute("INSERT OR IGNORE INTO character_member_items(mode,asset_id,sample_json) VALUES('ongoing',?1,?2)",params![s.image.id,serde_json::to_string(&s)?])?;
            }
        }
        drop(c);
        read()
    }

    fn member_reserve(&self, id: i64, mode: &str, s: &Sample, model: &str) -> Result<bool> {
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (state, cap, ongoing): (String, f64, String) = tx.query_row(
            "SELECT state,cap_usd,ongoing_mode FROM character_member_control WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if (mode == "backlog" && state != "running")
            || (mode == "ongoing" && !ongoing_on(&ongoing, Local::now().date_naive()))
        {
            return Ok(false);
        }
        if !eligible(&tx, s)? {
            return Ok(false);
        }
        let reserved = reservation(s, model);
        let (spent, cap) = if mode == "backlog" {
            (tx.query_row("SELECT COALESCE(SUM(COALESCE(r.actual_usd,r.reserved_usd)),0) FROM character_member_requests r JOIN character_member_items i ON i.id=r.item_id WHERE i.mode='backlog'",[],|r|r.get::<_,f64>(0))?,cap)
        } else {
            let cap: f64 = tx.query_row(
                "SELECT monthly_cap_usd FROM character_claude_settings WHERE singleton=1",
                [],
                |r| r.get(0),
            )?;
            (spend_usd(&tx, &month_start(Local::now()))?, cap)
        };
        if spent + reserved > cap {
            if mode == "backlog" {
                tx.execute(
                    "UPDATE character_member_control SET state='capped' WHERE singleton=1",
                    [],
                )?;
            }
            tx.commit()?;
            crate::activities::finish("character-members", None);
            return Ok(false);
        }
        tx.execute("INSERT INTO character_member_requests(item_id,model,reserved_usd,created_at) VALUES(?1,?2,?3,?4)",params![id,model,reserved,Utc::now().to_rfc3339()])?;
        tx.commit()?;
        Ok(true)
    }

    fn member_apply(
        &self,
        id: i64,
        s: &Sample,
        answer: &Answer,
        model: &str,
        mode: &str,
    ) -> Result<()> {
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state: String = tx.query_row(
            "SELECT state FROM character_member_control WHERE singleton=1",
            [],
            |r| r.get(0),
        )?;
        if mode == "backlog" && matches!(state.as_str(), "paused" | "cancelled") {
            return Ok(());
        }
        if !eligible(&tx, s)? {
            tx.execute(
                "UPDATE character_member_items SET state='skipped' WHERE id=?1",
                [id],
            )?;
            tx.commit()?;
            return Ok(());
        }
        // Recheck registration and the exact reference prefix, before writing any label.
        let mut targets = Vec::new();
        for member in &s.candidates {
            let target = match self.read_character_target(&tx, &member.id) {
                Ok(target) => target,
                Err(Error::NotFound) => {
                    tx.execute(
                        "UPDATE character_member_items SET state='skipped' WHERE id=?1",
                        [id],
                    )?;
                    tx.commit()?;
                    return Ok(());
                }
                Err(error) => return Err(error),
            };
            let hashes = target
                .references
                .iter()
                .filter(|r| r.status == "ready")
                .take(2)
                .map(|r| r.asset_hash.as_str())
                .collect::<Vec<_>>();
            if !target.enabled
                || target.role != "character"
                || target.series_classification_id.as_deref() != Some(s.series.as_str())
                || hashes
                    != member
                        .references
                        .iter()
                        .map(|r| r.hash.as_str())
                        .collect::<Vec<_>>()
            {
                tx.execute(
                    "UPDATE character_member_items SET state='skipped' WHERE id=?1",
                    [id],
                )?;
                tx.commit()?;
                return Ok(());
            }
            targets.push(target);
        }
        for present in &answer.present {
            let Some(index) = (0..s.candidates.len()).find(|i| probe::label(*i) == present.label)
            else {
                return Err(Error::Stale);
            };
            let target = &targets[index];
            let snapshot = json!({"scanId":null,"prediction":{"engine":"claude","memberIdentification":true,"model":model,"confidence":present.confidence},"references":target.references.iter().filter(|r|r.status=="ready").take(2).collect::<Vec<_>>()});
            if automatic(s, present.confidence) {
                self.accept_s36_in(&tx, target, &s.image.id, &s.image.hash, &snapshot)?;
            } else if s.member_count > 5 {
                tx.execute("INSERT OR REPLACE INTO character_member_recommendations(asset_id,asset_hash,target_id,target_revision,evidence_json) VALUES(?1,?2,?3,?4,?5)",params![s.image.id,s.image.hash,target.id,target.revision,serde_json::to_string(&snapshot)?])?;
                self.character_changes
                    .series_analysed(Some(s.series.as_str()));
            }
        }
        tx.execute(
            "UPDATE character_member_items SET state='done' WHERE id=?1",
            [id],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "character_member_run_tests.rs"]
mod tests;
