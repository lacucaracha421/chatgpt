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
    publication_pending: Vec<String>,
    publication_running: BTreeMap<String, usize>,
    publication_error: Option<String>,
}

impl Registry {
    fn publication_failed(&mut self, kind: &str, error: impl std::fmt::Display, now: i64) {
        self.publication_error = Some(format!("{kind}: {error}"));
        self.publication(now);
    }
    fn publication(&mut self, now: i64) {
        let mut kinds = self.publication_pending.clone();
        kinds.extend(self.publication_running.keys().cloned());
        kinds.sort();
        kinds.dedup();
        let failed = self.publication_running.is_empty() && self.publication_error.is_some();
        if kinds.is_empty() && !failed {
            self.finish("tablet-publication", None, now);
            return;
        }
        let running = !self.publication_running.is_empty();
        self.update(
            Activity {
                id: String::new(),
                key: "tablet-publication".into(),
                kind: "tablet_publication".into(),
                label: "태블릿용 게시".into(),
                state: if running {
                    "running"
                } else if failed {
                    "failed"
                } else {
                    "queued"
                }
                .into(),
                done: 0,
                total: None,
                detail: Some(kinds.join(" · ")),
                pausable: false,
                pause_group: None,
                paused_reason: None,
                error: if failed {
                    self.publication_error.clone()
                } else {
                    None
                },
                started_at: 0,
                finished_at: None,
            },
            now,
        );
    }
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
        if next.state == "failed" {
            // Keep the latest failure for a logical job, including retries that
            // created a new running row. Successful runs retain their own history.
            self.rows
                .retain(|id, row| id == &next.id || row.key != next.key || row.state != "failed");
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
        let Some(mut row) = self
            .rows
            .values()
            .find(|row| row.key == key && row.finished_at.is_none())
            .cloned()
        else {
            return;
        };
        row.state = if error.is_some() { "failed" } else { "done" }.into();
        row.error = error;
        row.paused_reason = None;
        self.update(row, now);
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

pub fn publication_pending(kinds: Vec<String>) {
    change(|registry| {
        registry.publication_pending = kinds;
        registry.publication(now());
    });
}

// Lane counts keep one row running until the last concurrent sender returns.
thread_local! {
    static PUBLICATION_LANE: std::cell::RefCell<Option<(String, std::rc::Rc<std::cell::Cell<bool>>)>> = const { std::cell::RefCell::new(None) };
}
pub struct PublicationLane {
    kind: String,
    started: std::rc::Rc<std::cell::Cell<bool>>,
    previous: Option<(String, std::rc::Rc<std::cell::Cell<bool>>)>,
    finished: bool,
}
impl PublicationLane {
    pub fn start(kind: &str) -> Self {
        let started = std::rc::Rc::new(std::cell::Cell::new(false));
        let previous =
            PUBLICATION_LANE.with(|lane| lane.replace(Some((kind.into(), started.clone()))));
        Self {
            kind: kind.into(),
            started,
            previous,
            finished: false,
        }
    }
    pub fn complete<T, E: std::fmt::Display>(mut self, result: &Result<T, E>) {
        self.finished = true;
        if let Err(error) = result {
            change(|registry| {
                registry.publication_failed(&self.kind, error, now());
            });
        }
    }
}
impl Drop for PublicationLane {
    fn drop(&mut self) {
        PUBLICATION_LANE.with(|lane| lane.replace(self.previous.take()));
        change(|registry| {
            if !self.finished {
                registry.publication_failed(&self.kind, "작업이 중단되었습니다", now());
            }
            if !self.started.get() {
                if registry.publication_error.is_some() {
                    registry.publication(now());
                }
                return;
            }
            if let Some(count) = registry.publication_running.get_mut(&self.kind) {
                *count -= 1;
                if *count == 0 {
                    registry.publication_running.remove(&self.kind);
                }
            }
            registry.publication(now());
        });
    }
}

/// Only a real CloudClient request activates a dispatched publication probe.
pub fn publication_request() {
    let kind = PUBLICATION_LANE.with(|lane| {
        lane.borrow()
            .as_ref()
            .and_then(|(kind, started)| (!started.replace(true)).then(|| kind.clone()))
    });
    if let Some(kind) = kind {
        change(|registry| {
            if registry.publication_running.is_empty() {
                registry.publication_error = None;
            }
            *registry.publication_running.entry(kind).or_default() += 1;
            registry.publication(now());
        });
    }
}

thread_local! {
    static REQUEST_JOB: std::cell::RefCell<Option<std::rc::Rc<RequestJob>>> = const { std::cell::RefCell::new(None) };
}
/// Conditional exchange owners can do a wholly local no-op. Start their row
/// only when CloudClient reaches a request, and finish after the owner returns.
pub struct RequestJob {
    key: String,
    kind: &'static str,
    label: &'static str,
    job: std::cell::RefCell<Option<Job>>,
}
impl RequestJob {
    pub fn run<T, E: std::fmt::Display>(
        key: impl Into<String>,
        kind: &'static str,
        label: &'static str,
        work: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        let scope = std::rc::Rc::new(Self {
            key: key.into(),
            kind,
            label,
            job: std::cell::RefCell::new(None),
        });
        let previous = REQUEST_JOB.with(|current| current.replace(Some(scope.clone())));
        struct Restore(Option<std::rc::Rc<RequestJob>>);
        impl Drop for Restore {
            fn drop(&mut self) {
                REQUEST_JOB.with(|current| current.replace(self.0.take()));
            }
        }
        let _restore = Restore(previous);
        let result = work();
        if let Some(mut job) = scope.job.borrow_mut().take() {
            job.complete(&result);
        }
        result
    }
}
pub fn request_started() {
    publication_request();
    let scope = REQUEST_JOB.with(|current| current.borrow().clone());
    if let Some(scope) = scope {
        let mut job = scope.job.borrow_mut();
        if job.is_none() {
            *job = Some(Job::start(&scope.key, scope.kind, scope.label, None));
        }
    }
}

/// Guards exceptional exits; successful callers explicitly record their outcome.
pub struct Job {
    key: String,
    finished: bool,
}
impl Job {
    pub fn run<T, E: std::fmt::Display>(
        key: impl Into<String>,
        kind: &str,
        label: &str,
        group: Option<&str>,
        work: impl FnOnce(&Job) -> Result<T, E>,
    ) -> Result<T, E> {
        let mut job = Self::start(key, kind, label, group);
        let result = work(&job);
        job.complete(&result);
        result
    }
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
    #[test]
    fn activity_registry_publication_retry_replaces_failure_with_lane_label() {
        let mut registry = Registry::default();
        registry.publication_running.insert("캐릭터".into(), 1);
        registry.publication(1);
        registry.publication_failed("캐릭터", "인증 실패", 2);
        registry.publication_running.clear();
        registry.publication(3);
        assert_eq!(
            registry.snapshot(3).jobs[0].error.as_deref(),
            Some("캐릭터: 인증 실패")
        );

        registry.publication_error = None;
        registry.publication_running.insert("폴더 정보".into(), 1);
        registry.publication(4);
        registry.publication_failed("폴더 정보", "인증 실패", 5);
        registry.publication_running.clear();
        registry.publication(6);
        let jobs = registry.snapshot(6).jobs;
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].error.as_deref(), Some("폴더 정보: 인증 실패"));
        assert_eq!(jobs[0].started_at, 4);
        assert_eq!(jobs[0].finished_at, Some(6));
        registry.publication(7);
        assert_eq!(registry.snapshot(7).jobs.len(), 1);
    }
    #[test]
    fn activity_registry_repeated_finish_keeps_latest_failure_and_other_keys() {
        let mut registry = Registry::default();
        registry.update(row("other"), 1);
        registry.finish("other", Some("other failure".into()), 2);
        for (start, error) in [(3, "first"), (5, "first"), (7, "changed")] {
            registry.update(row("retry"), start);
            registry.progress("retry", start as u64, Some(10), None);
            registry.finish("retry", Some(error.into()), start + 1);
            assert_eq!(registry.snapshot(start + 1).jobs.len(), 2);
        }
        let jobs = registry.snapshot(9).jobs;
        let retry = jobs.iter().find(|job| job.key == "retry").unwrap();
        assert_eq!(retry.error.as_deref(), Some("changed"));
        assert_eq!(retry.done, 7);
        assert_eq!(retry.finished_at, Some(8));
        for start in [10, 12] {
            registry.update(row("retry"), start);
            registry.finish("retry", None, start + 1);
        }
        assert_eq!(
            registry
                .snapshot(14)
                .jobs
                .iter()
                .filter(|job| job.state == "done")
                .count(),
            2
        );
    }
    #[test]
    fn activity_registry_changed_terminal_failure_replaces_previous_projection() {
        let mut registry = Registry::default();
        let mut failed = row("projection");
        failed.state = "failed".into();
        failed.error = Some("first".into());
        registry.update(failed.clone(), 1);
        registry.update(failed.clone(), 2);
        failed.error = Some("changed".into());
        registry.update(failed, 3);
        assert_eq!(registry.snapshot(3).jobs.len(), 1);
        assert_eq!(
            registry.snapshot(3).jobs[0].error.as_deref(),
            Some("changed")
        );
    }
    #[test]
    fn activity_registry_publication_batches_and_overlapping_senders_share_one_row() {
        let mut registry = Registry::default();
        registry.publication_pending = vec!["캐릭터".into(), "컬렉션".into()];
        registry.publication(1);
        let queued = registry.snapshot(1).jobs.remove(0);
        assert_eq!(queued.state, "queued");
        assert_eq!(queued.label, "태블릿용 게시");
        assert!(queued.detail.as_ref().unwrap().contains("캐릭터"));
        registry.publication_running.insert("캐릭터".into(), 1);
        registry.publication_running.insert("홈".into(), 1);
        registry.publication(2);
        assert_eq!(registry.snapshot(2).jobs.len(), 1);
        assert_eq!(registry.snapshot(2).jobs[0].id, queued.id);
        registry.publication_pending.clear();
        registry.publication_running.remove("캐릭터");
        registry.publication(3);
        assert_eq!(registry.snapshot(3).jobs[0].state, "running");
        registry.publication_running.clear();
        registry.publication(4);
        assert_eq!(registry.snapshot(4).jobs[0].state, "done");
    }
    #[test]
    fn activity_registry_publication_failure_stays_visible_during_retry_wait() {
        let mut registry = Registry::default();
        registry.publication_pending = vec!["홈".into()];
        registry.publication(1);
        registry.publication_error = Some("요청 실패".into());
        registry.publication(2);
        registry.publication(3);
        assert_eq!(registry.snapshot(3).jobs.len(), 1);
        assert_eq!(registry.snapshot(3).jobs[0].state, "failed");
        registry.publication_error = None;
        registry.publication_running.insert("홈".into(), 1);
        registry.publication(4);
        assert_eq!(
            registry
                .snapshot(4)
                .jobs
                .iter()
                .filter(|row| row.finished_at.is_none())
                .count(),
            1
        );
    }
    #[test]
    fn activity_registry_auxiliary_character_jobs_inherit_shared_pause() {
        let mut registry = Registry::default();
        for kind in [
            "character_augmentation",
            "character_shadow",
            "character_shadow_backfill",
        ] {
            let mut activity = row(kind);
            activity.kind = kind.into();
            activity.state = "queued".into();
            registry.update(activity, 1);
        }
        registry.pause("character", Some("일시 정지됨".into()));
        assert!(registry
            .snapshot(2)
            .jobs
            .iter()
            .all(|row| row.state == "paused" && row.pausable));
        registry.pause("character", None);
        assert!(registry
            .snapshot(3)
            .jobs
            .iter()
            .all(|row| row.state == "queued" && row.paused_reason.is_none()));
    }
    #[test]
    fn activity_registry_conditional_requests_only_start_on_real_work() {
        let key = format!("request-test:{}", uuid::Uuid::new_v4());
        let noop: Result<(), &str> = RequestJob::run(&key, "test", "test", || Ok(()));
        assert!(noop.is_ok());
        assert!(!activity_snapshot().jobs.iter().any(|row| row.key == key));
        let result: Result<(), &str> = RequestJob::run(&key, "test", "test", || {
            request_started();
            let current = activity_snapshot()
                .jobs
                .into_iter()
                .find(|row| row.key == key)
                .unwrap();
            assert_eq!(current.state, "running");
            Err("fixture failure")
        });
        assert!(result.is_err());
        let current = activity_snapshot()
            .jobs
            .into_iter()
            .find(|row| row.key == key)
            .unwrap();
        assert_eq!(current.state, "failed");
        dismiss_activity(current.id);
    }
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
