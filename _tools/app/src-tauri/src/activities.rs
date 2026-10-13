//! Session-only background activity projection. Producers own work and controls;
//! this registry only records their state and wakes one coalesced event sender.
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{Arc, Condvar, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::Emitter;

pub const EVENT: &str = "library://activities-changed";
const COALESCE: Duration = Duration::from_millis(250);
const HOUR: i64 = 3_600_000;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: String,
    pub key: String,
    pub kind: String,
    pub label: String,
    pub state: String,
    pub done: u64,
    pub total: Option<u64>,
    pub detail: Option<String>,
    pub pausable: bool,
    pub pause_group: Option<String>,
    pub paused_reason: Option<String>,
    pub error: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub jobs: Vec<Activity>,
}

#[derive(Default)]
struct Registry {
    rows: BTreeMap<String, Activity>,
    revision: u64,
    sequence: u64,
    pauses: BTreeMap<String, Option<String>>,
    dismissed: BTreeMap<String, (String, Option<String>)>,
    dirty: bool,
    last_emit: Option<Instant>,
}

impl Registry {
    fn changed(&mut self) {
        self.revision += 1;
        self.dirty = true;
    }
    fn update(&mut self, mut next: Activity, now: i64) {
        if matches!(next.state.as_str(), "done" | "failed") {
            if self.dismissed.get(&next.key) == Some(&(next.state.clone(), next.error.clone())) {
                return;
            }
        } else {
            self.dismissed.remove(&next.key);
        }
        if let Some(old) = self
            .rows
            .values()
            .find(|row| row.key == next.key && row.finished_at.is_none())
        {
            next.id = old.id.clone();
            next.started_at = old.started_at;
            if *old == next {
                return;
            }
        } else {
            // Repeated terminal projections do not create new history entries.
            if let Some(old) = self
                .rows
                .values()
                .filter(|row| row.key == next.key)
                .max_by_key(|row| row.started_at)
            {
                if old.state == next.state
                    && old.error == next.error
                    && matches!(next.state.as_str(), "failed" | "done")
                {
                    return;
                }
            }
            self.sequence += 1;
            next.id = format!("activity-{}", self.sequence);
            next.started_at = now;
        }
        if matches!(next.state.as_str(), "failed" | "done") {
            next.finished_at = Some(now);
        }
        self.rows.insert(next.id.clone(), next);
        self.prune(now);
        self.changed();
    }
    fn progress(&mut self, key: &str, done: u64, total: Option<u64>, detail: Option<String>) {
        if let Some(row) = self
            .rows
            .values_mut()
            .find(|row| row.key == key && row.finished_at.is_none())
        {
            if row.done == done && row.total == total && row.detail == detail {
                return;
            }
            row.done = done;
            row.total = total;
            row.detail = detail;
            self.changed();
        }
    }
    fn defer(&mut self, key: &str, reason: Option<String>) {
        if let Some(row) = self
            .rows
            .values_mut()
            .find(|row| row.key == key && row.finished_at.is_none())
        {
            let reason = reason.or_else(|| row.paused_reason.clone());
            let state = if reason.is_some() { "paused" } else { "queued" };
            if row.paused_reason == reason && row.state == state {
                return;
            }
            row.paused_reason = reason;
            row.state = state.into();
            self.changed();
        }
    }
    fn finish(&mut self, key: &str, error: Option<String>, now: i64) {
        let Some(row) = self
            .rows
            .values_mut()
            .find(|row| row.key == key && row.finished_at.is_none())
        else {
            return;
        };
        row.state = if error.is_some() { "failed" } else { "done" }.into();
        row.error = error;
        row.finished_at = Some(now);
        row.paused_reason = None;
        self.prune(now);
        self.changed();
    }
    fn prune(&mut self, now: i64) {
        let mut completed: Vec<_> = self
            .rows
            .values()
            .filter(|row| row.state == "done")
            .map(|row| (row.finished_at.unwrap_or(0), row.id.clone()))
            .collect();
        completed.sort_by(|a, b| b.cmp(a));
        for (index, (at, id)) in completed.into_iter().enumerate() {
            if index >= 10 || now - at >= HOUR {
                self.rows.remove(&id);
            }
        }
    }
    fn pause(&mut self, group: &str, reason: Option<String>) {
        if self.pauses.get(group) == Some(&reason) {
            return;
        }
        self.pauses.insert(group.into(), reason.clone());
        let mut changed = false;
        for row in self
            .rows
            .values_mut()
            .filter(|row| row.pause_group.as_deref() == Some(group) && row.finished_at.is_none())
        {
            // Resuming waits for the producer to report that it actually owns work.
            // The shared pause never destroys a producer's saver/budget reason.
            if reason.is_none() {
                row.state = "queued".into();
            }
            changed = true;
        }
        if changed {
            self.changed();
        }
    }
    fn snapshot(&self, now: i64) -> Snapshot {
        Snapshot {
            revision: self.revision,
            jobs: self
                .rows
                .values()
                .filter(|row| row.state != "done" || now - row.finished_at.unwrap_or(0) < HOUR)
                .map(|row| {
                    let mut row = row.clone();
                    if row.finished_at.is_none() {
                        if let Some(reason) = row
                            .pause_group
                            .as_ref()
                            .and_then(|group| self.pauses.get(group))
                            .cloned()
                            .flatten()
                        {
                            row.state = "paused".into();
                            row.paused_reason = Some(reason);
                        }
                    }
                    row
                })
                .collect(),
        }
    }
    fn take_event(&mut self, now: Instant) -> bool {
        if !self.dirty
            || self
                .last_emit
                .is_some_and(|last| now.duration_since(last) < COALESCE)
        {
            return false;
        }
        self.dirty = false;
        self.last_emit = Some(now);
        true
    }
}

#[derive(Default)]
struct Shared {
    registry: Mutex<Registry>,
    wake: Condvar,
}
fn shared() -> &'static Arc<Shared> {
    static REGISTRY: OnceLock<Arc<Shared>> = OnceLock::new();
    REGISTRY.get_or_init(|| Arc::new(Shared::default()))
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn change(f: impl FnOnce(&mut Registry)) {
    let shared = shared();
    f(&mut shared
        .registry
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner));
    shared.wake.notify_one();
}

pub fn setup(app: &tauri::AppHandle) {
    let app = app.clone();
    let shared = shared().clone();
    std::thread::spawn(move || loop {
        let mut registry = shared
            .registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while !registry.dirty {
            registry = shared
                .wake
                .wait(registry)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        if !registry.take_event(Instant::now()) {
            let delay = COALESCE.saturating_sub(registry.last_emit.unwrap().elapsed());
            drop(
                shared
                    .wake
                    .wait_timeout(registry, delay)
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
            );
            continue;
        }
        let snapshot = registry.snapshot(now());
        drop(registry);
        let _ = app.emit(EVENT, snapshot);
    });
}

pub fn report(
    key: &str,
    kind: &str,
    label: &str,
    state: &str,
    done: u64,
    total: Option<u64>,
    detail: Option<String>,
    pause_group: Option<&str>,
    reason: Option<String>,
    error: Option<String>,
) {
    change(|registry| {
        registry.update(
            Activity {
                id: String::new(),
                key: key.into(),
                kind: kind.into(),
                label: label.into(),
                state: state.into(),
                done,
                total,
                detail,
                pausable: pause_group.is_some(),
                pause_group: pause_group.map(str::to_owned),
                paused_reason: reason,
                error,
                started_at: 0,
                finished_at: None,
            },
            now(),
        )
    });
}
pub fn finish(key: &str, error: Option<String>) {
    change(|registry| registry.finish(key, error, now()));
}
pub fn progress(key: &str, done: u64, total: Option<u64>, detail: Option<String>) {
    change(|registry| registry.progress(key, done, total, detail));
}
/// A healthy observation allows a future failure to be reported after dismissal.
pub fn clear_dismissed(key: &str) {
    change(|registry| {
        registry.dismissed.remove(key);
    });
}
pub fn pause_group(group: &str, reason: Option<String>) {
    change(|registry| registry.pause(group, reason));
}
pub fn finish_missing(kind: &str, keys: &[String]) {
    change(|registry| {
        let missing: Vec<_> = registry
            .rows
            .values()
            .filter(|row| row.kind == kind && row.finished_at.is_none() && !keys.contains(&row.key))
            .map(|row| row.key.clone())
            .collect();
        for key in missing {
            registry.finish(&key, None, now());
        }
    });
}

/// Guards exceptional exits; successful callers explicitly record their outcome.
pub struct Job {
    key: String,
    finished: bool,
}
impl Job {
    pub fn start(key: impl Into<String>, kind: &str, label: &str, group: Option<&str>) -> Self {
        let key = key.into();
        report(
            &key, kind, label, "running", 0, None, None, group, None, None,
        );
        Self {
            key,
            finished: false,
        }
    }
    pub fn progress(&self, done: u64, total: Option<u64>, detail: Option<String>) {
        progress(&self.key, done, total, detail);
    }
    pub fn complete<T, E: std::fmt::Display>(&mut self, result: &Result<T, E>) {
        finish(&self.key, result.as_ref().err().map(ToString::to_string));
        self.finished = true;
    }
    pub fn defer(mut self, reason: Option<String>) {
        change(|registry| registry.defer(&self.key, reason));
        self.finished = true;
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        if !self.finished {
            finish(&self.key, Some("작업이 중단되었습니다".into()));
        }
    }
}

#[tauri::command]
pub fn activity_snapshot() -> Snapshot {
    shared()
        .registry
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .snapshot(now())
}
#[tauri::command]
pub fn dismiss_activity(id: String) {
    change(|registry| {
        if registry
            .rows
            .get(&id)
            .is_some_and(|row| row.finished_at.is_some())
        {
            if let Some(row) = registry.rows.remove(&id) {
                registry.dismissed.insert(row.key, (row.state, row.error));
            }
            registry.changed();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(key: &str) -> Activity {
        Activity {
            id: String::new(),
            key: key.into(),
            kind: "character".into(),
            label: key.into(),
            state: "running".into(),
            done: 0,
            total: None,
            detail: None,
            pausable: true,
            pause_group: Some("character".into()),
            paused_reason: None,
            error: None,
            started_at: 0,
            finished_at: None,
        }
    }
    #[test]
    fn activity_registry_start_progress_finish() {
        let mut r = Registry::default();
        r.update(row("a"), 10);
        let id = r.snapshot(10).jobs[0].id.clone();
        let mut next = row("a");
        next.done = 2;
        next.total = Some(5);
        r.progress("a", 2, Some(5), None);
        assert_eq!(r.snapshot(20).jobs[0].started_at, 10);
        assert_eq!(r.snapshot(20).jobs[0].id, id);
        let revision = r.revision;
        r.update(next, 30);
        assert_eq!(r.revision, revision);
        r.finish("a", None, 40);
        assert_eq!(r.snapshot(40).jobs[0].state, "done");
        assert_eq!(r.snapshot(HOUR + 40).jobs.len(), 0);
    }
    #[test]
    fn activity_registry_coalesces_with_trailing_change() {
        let mut r = Registry::default();
        let at = Instant::now();
        r.update(row("a"), 0);
        assert!(r.take_event(at));
        r.update(row("b"), 1);
        assert!(!r.take_event(at + Duration::from_millis(249)));
        assert!(r.dirty);
        assert!(r.take_event(at + COALESCE));
        assert!(!r.take_event(at + COALESCE * 2));
    }
    #[test]
    fn activity_registry_deferred_work_stays_waiting_with_its_progress() {
        let mut r = Registry::default();
        r.update(row("a"), 0);
        r.progress("a", 2, Some(5), None);
        r.defer("a", Some("절약 모드".into()));
        let snapshot = r.snapshot(1);
        assert_eq!(snapshot.jobs[0].state, "paused");
        assert_eq!(snapshot.jobs[0].done, 2);
        assert_eq!(snapshot.jobs[0].paused_reason.as_deref(), Some("절약 모드"));
        assert!(snapshot.jobs[0].finished_at.is_none());
    }
    #[test]
    fn activity_registry_pause_propagates_to_existing_and_new_character_jobs() {
        let mut r = Registry::default();
        r.update(row("a"), 0);
        r.pause("character", Some("일시 정지됨".into()));
        r.update(row("b"), 1);
        let mut capped = row("c");
        capped.state = "queued".into();
        capped.paused_reason = Some("이번 달 한도".into());
        r.update(capped, 2);
        assert!(r.snapshot(1).jobs.iter().all(|row| row.state == "paused"));
        r.pause("character", None);
        assert!(r
            .snapshot(2)
            .jobs
            .iter()
            .any(|row| row.key == "c" && row.paused_reason.as_deref() == Some("이번 달 한도")));
        assert!(r.snapshot(2).jobs.iter().all(|row| row.state == "queued"));
        r.update(row("a"), 3);
        assert_eq!(r.snapshot(3).jobs[0].state, "running");
    }
    #[test]
    fn activity_registry_keeps_problems_and_limits_history() {
        let mut r = Registry::default();
        r.update(row("failed"), 0);
        r.finish("failed", Some("error".into()), 1);
        for n in 0..12 {
            let key = format!("j{n}");
            r.update(row(&key), n);
            r.finish(&key, None, n);
        }
        assert_eq!(r.snapshot(20).jobs.len(), 11);
        r.prune(HOUR + 20);
        assert_eq!(r.snapshot(HOUR + 20).jobs.len(), 1);
    }
}
