//! The "카드 누끼 만들기" background job as a state machine over an `Env`, so every rule
//! (workload gate, order, retries with backoff, progress) is tested without a model, a
//! server or a window. `run_pass` does at most `BATCH` images and returns what to do next.
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

pub(crate) const KEY: &str = "card-cutouts";
pub(crate) const KIND: &str = "card_cutouts";
pub(crate) const LABEL: &str = "카드 누끼 만들기";
/// Images per pass; the candidate list is read again after each pass so a freshly granted
/// pack jumps the queue.
pub(crate) const BATCH: usize = 10;
const RETRY_FIRST: Duration = Duration::from_secs(60);
const RETRY_MAX: Duration = Duration::from_secs(6 * 3600);
const NOT_LOCAL_RECHECK: Duration = Duration::from_secs(30 * 60);
pub(crate) const IDLE_WAIT: Duration = Duration::from_secs(10 * 60);
pub(crate) const CLOSED_WAIT: Duration = Duration::from_secs(60);
pub(crate) const MORE_WAIT: Duration = Duration::from_secs(2);
const FATAL_WAIT: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct GateInputs {
    pub restricted: bool,
    pub has_library: bool,
    pub cloud_ready: bool,
    pub has_token: bool,
    pub runtime_ready: bool,
    pub character_busy: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Gate {
    Open,
    /// Not now. `visible` reasons are shown in the 작업 panel while work waits; the others
    /// (nothing is set up yet) stay silent.
    Closed {
        reason: &'static str,
        visible: bool,
    },
}

/// Heavy work runs only when the PC is free for it: never in 절약 모드, and never while the
/// character recognition owner is busy (one model process at a time).
pub(crate) fn decide(inputs: GateInputs) -> Gate {
    let closed = |reason, visible| Gate::Closed { reason, visible };
    if inputs.restricted {
        closed("절약 모드", true)
    } else if inputs.character_busy {
        closed("캐릭터 분석이 끝나면 시작", true)
    } else if !inputs.has_library {
        closed("라이브러리를 열면 시작", false)
    } else if !inputs.cloud_ready || !inputs.has_token {
        closed("서버 게시 설정이 필요", false)
    } else if !inputs.runtime_ready {
        closed("분석 환경 설정이 필요", false)
    } else {
        Gate::Open
    }
}

pub(crate) fn backoff(failures: u32) -> Duration {
    let steps = failures.saturating_sub(1).min(16);
    RETRY_FIRST.saturating_mul(1u32 << steps).min(RETRY_MAX)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// Only this image failed; it is retried later.
    Asset,
    /// The whole pass cannot go on (authorisation, model, interpreter); wait longer.
    Fatal,
    /// The gate closed or the app is exiting while the model worked.
    Interrupted,
}

#[derive(Debug)]
pub(crate) struct JobError {
    pub message: String,
    pub kind: Kind,
}

impl JobError {
    pub(crate) fn asset(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: Kind::Asset,
        }
    }
    pub(crate) fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: Kind::Fatal,
        }
    }
    pub(crate) fn interrupted() -> Self {
        Self {
            message: "중단됨".into(),
            kind: Kind::Interrupted,
        }
    }
}

pub(crate) enum Made {
    /// Cut and stored; the cached cutout is ready to upload.
    Cached,
    /// The image is on the server but not in this PC's library.
    NotLocal,
}

pub(crate) enum Report {
    Running {
        done: u64,
        total: u64,
    },
    Queued {
        remaining: u64,
    },
    Paused {
        reason: &'static str,
        remaining: u64,
    },
    Failed(String),
    Done,
}

pub(crate) trait Env {
    fn now(&self) -> Instant;
    fn gate(&mut self) -> Gate;
    fn candidates(&mut self) -> Result<Vec<String>, JobError>;
    fn is_cached(&mut self, id: &str) -> bool;
    /// Cuts `id` from the local library into the cache, downloading the model first if needed
    /// (the implementation shows that progress itself).
    fn make(&mut self, id: &str) -> Result<Made, JobError>;
    fn upload(&mut self, id: &str) -> Result<(), JobError>;
    fn report(&mut self, report: Report);
}

#[derive(Default)]
pub(crate) struct State {
    failures: HashMap<String, (u32, Instant)>,
    not_local: HashMap<String, Instant>,
    fatal: Option<(u32, Instant)>,
    /// Images known to be waiting, so a closed gate can say how many.
    pub pending: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Pass {
    /// Nothing to do.
    Idle,
    /// Gate closed; wait for a wake or the polling interval.
    Closed,
    /// `done` uploaded, `failed` set aside for a retry, `more` are still waiting now.
    Worked { done: u64, failed: u64, more: bool },
    /// The pass could not run at all.
    Failed,
}

impl State {
    fn waiting(&self, id: &str, now: Instant) -> bool {
        self.failures.get(id).is_some_and(|(_, at)| *at > now)
            || self.not_local.get(id).is_some_and(|at| *at > now)
    }

    fn fail(&mut self, id: &str, now: Instant) {
        let count = self.failures.get(id).map_or(0, |(n, _)| *n) + 1;
        self.failures
            .insert(id.to_owned(), (count, now + backoff(count)));
    }

    pub(crate) fn failures_of(&self, id: &str) -> u32 {
        self.failures.get(id).map_or(0, |(n, _)| *n)
    }

    /// How long to wait before the next pass.
    pub(crate) fn delay(&self, pass: &Pass, now: Instant) -> Duration {
        match pass {
            Pass::Closed => CLOSED_WAIT,
            Pass::Failed => self.fatal.map_or(FATAL_WAIT, |(n, _)| {
                backoff(n).max(Duration::from_secs(5 * 60)).min(FATAL_WAIT)
            }),
            Pass::Worked { more: true, .. } => MORE_WAIT,
            Pass::Worked { .. } | Pass::Idle => {
                // Wake for the earliest retry, but not more often than a minute.
                let next = self
                    .failures
                    .values()
                    .map(|(_, at)| *at)
                    .filter(|at| *at > now)
                    .min()
                    .map(|at| at - now);
                next.map_or(IDLE_WAIT, |wait| wait.clamp(CLOSED_WAIT, IDLE_WAIT))
            }
        }
    }
}

pub(crate) fn run_pass(env: &mut dyn Env, state: &mut State) -> Pass {
    if let Gate::Closed { reason, visible } = env.gate() {
        if visible && state.pending > 0 {
            env.report(Report::Paused {
                reason,
                remaining: state.pending,
            });
        }
        return Pass::Closed;
    }
    let now = env.now();
    let ids = match env.candidates() {
        Ok(ids) => ids,
        Err(error) => {
            let count = state.fatal.map_or(0, |(n, _)| n) + 1;
            state.fatal = Some((count, now));
            env.report(Report::Failed(error.message));
            return Pass::Failed;
        }
    };
    state.fatal = None;
    state.failures.retain(|id, _| ids.contains(id));
    state.not_local.retain(|id, _| ids.contains(id));
    let ready: Vec<&String> = ids.iter().filter(|id| !state.waiting(id, now)).collect();
    state.pending = ready.len() as u64;
    if ready.is_empty() {
        env.report(Report::Done);
        return Pass::Idle;
    }
    let total = ready.len().min(BATCH) as u64;
    let (mut done, mut failed, mut handled) = (0u64, 0u64, 0usize);
    env.report(Report::Running { done: 0, total });
    for id in ready.iter().take(BATCH) {
        if let Gate::Closed { reason, .. } = env.gate() {
            env.report(Report::Paused {
                reason,
                remaining: state.pending,
            });
            return Pass::Closed;
        }
        let outcome = (|| {
            if !env.is_cached(id) {
                match env.make(id)? {
                    Made::Cached => {}
                    Made::NotLocal => return Ok(false),
                }
            }
            env.upload(id).map(|()| true)
        })();
        handled += 1;
        match outcome {
            Ok(true) => {
                done += 1;
                state.failures.remove(id.as_str());
                state.pending = state.pending.saturating_sub(1);
                env.report(Report::Running { done, total });
            }
            Ok(false) => {
                state
                    .not_local
                    .insert((*id).clone(), env.now() + NOT_LOCAL_RECHECK);
                state.pending = state.pending.saturating_sub(1);
            }
            Err(error) if error.kind == Kind::Fatal => {
                let count = state.fatal.map_or(0, |(n, _)| n) + 1;
                state.fatal = Some((count, env.now()));
                env.report(Report::Failed(error.message));
                return Pass::Failed;
            }
            Err(error) if error.kind == Kind::Interrupted => {
                if let Gate::Closed { reason, .. } = env.gate() {
                    env.report(Report::Paused {
                        reason,
                        remaining: state.pending,
                    });
                }
                return Pass::Closed;
            }
            Err(_) => {
                failed += 1;
                state.fail(id, env.now());
            }
        }
    }
    let more = ready.len() > handled;
    if more {
        env.report(Report::Queued {
            remaining: state.pending,
        });
    } else if failed > 0 {
        env.report(Report::Queued { remaining: failed });
    } else {
        env.report(Report::Done);
    }
    Pass::Worked { done, failed, more }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashSet, VecDeque};

    struct Fake {
        clock: Instant,
        gates: VecDeque<Gate>,
        ids: Result<Vec<String>, String>,
        cached: HashSet<String>,
        not_local: HashSet<String>,
        broken: HashSet<String>,
        upload_fail: HashSet<String>,
        fatal_upload: bool,
        log: Vec<String>,
        reports: Vec<String>,
    }

    impl Fake {
        fn new(ids: &[&str]) -> Self {
            Self {
                clock: Instant::now(),
                gates: VecDeque::new(),
                ids: Ok(ids.iter().map(|s| s.to_string()).collect()),
                cached: HashSet::new(),
                not_local: HashSet::new(),
                broken: HashSet::new(),
                upload_fail: HashSet::new(),
                fatal_upload: false,
                log: vec![],
                reports: vec![],
            }
        }
    }

    impl Env for Fake {
        fn now(&self) -> Instant {
            self.clock
        }
        fn gate(&mut self) -> Gate {
            self.gates.pop_front().unwrap_or(Gate::Open)
        }
        fn candidates(&mut self) -> Result<Vec<String>, JobError> {
            self.log.push("candidates".into());
            self.ids.clone().map_err(JobError::fatal)
        }
        fn is_cached(&mut self, id: &str) -> bool {
            self.cached.contains(id)
        }
        fn make(&mut self, id: &str) -> Result<Made, JobError> {
            self.log.push(format!("make {id}"));
            if self.not_local.contains(id) {
                return Ok(Made::NotLocal);
            }
            if self.broken.contains(id) {
                return Err(JobError::asset("boom"));
            }
            self.cached.insert(id.to_owned());
            Ok(Made::Cached)
        }
        fn upload(&mut self, id: &str) -> Result<(), JobError> {
            self.log.push(format!("upload {id}"));
            if self.fatal_upload {
                return Err(JobError::fatal("unauthorized"));
            }
            if self.upload_fail.contains(id) {
                return Err(JobError::asset("offline"));
            }
            // The server stops listing what it now has.
            if let Ok(ids) = &mut self.ids {
                ids.retain(|candidate| candidate != id);
            }
            Ok(())
        }
        fn report(&mut self, report: Report) {
            self.reports.push(match report {
                Report::Running { done, total } => format!("running {done}/{total}"),
                Report::Queued { remaining } => format!("queued {remaining}"),
                Report::Paused { reason, remaining } => format!("paused {reason} {remaining}"),
                Report::Failed(why) => format!("failed {why}"),
                Report::Done => "done".into(),
            });
        }
    }

    #[test]
    fn the_gate_follows_the_workload_rules_in_order() {
        let open = GateInputs {
            restricted: false,
            has_library: true,
            cloud_ready: true,
            has_token: true,
            runtime_ready: true,
            character_busy: false,
        };
        assert_eq!(decide(open), Gate::Open);
        assert_eq!(
            decide(GateInputs {
                restricted: true,
                character_busy: true,
                ..open
            }),
            Gate::Closed {
                reason: "절약 모드",
                visible: true
            }
        );
        assert!(matches!(
            decide(GateInputs {
                character_busy: true,
                ..open
            }),
            Gate::Closed { visible: true, .. }
        ));
        for silent in [
            GateInputs {
                has_library: false,
                ..open
            },
            GateInputs {
                cloud_ready: false,
                ..open
            },
            GateInputs {
                has_token: false,
                ..open
            },
            GateInputs {
                runtime_ready: false,
                ..open
            },
        ] {
            assert!(
                matches!(decide(silent), Gate::Closed { visible: false, .. }),
                "{silent:?}"
            );
        }
    }

    #[test]
    fn backoff_doubles_from_a_minute_up_to_six_hours() {
        let minutes: Vec<u64> = (1..=12).map(|n| backoff(n).as_secs() / 60).collect();
        assert_eq!(minutes, [1, 2, 4, 8, 16, 32, 64, 128, 256, 360, 360, 360]);
        assert_eq!(backoff(0), RETRY_FIRST);
        assert_eq!(backoff(u32::MAX), RETRY_MAX);
    }

    #[test]
    fn candidates_are_cut_and_uploaded_in_the_servers_order() {
        let mut env = Fake::new(&["b", "a", "c"]);
        let mut state = State::default();
        assert_eq!(
            run_pass(&mut env, &mut state),
            Pass::Worked {
                done: 3,
                failed: 0,
                more: false
            }
        );
        assert_eq!(
            env.log,
            [
                "candidates",
                "make b",
                "upload b",
                "make a",
                "upload a",
                "make c",
                "upload c"
            ]
        );
        assert_eq!(env.reports.first().map(String::as_str), Some("running 0/3"));
        assert_eq!(env.reports.last().map(String::as_str), Some("done"));
        assert_eq!(state.pending, 0);
    }

    #[test]
    fn a_cutout_already_in_the_cache_is_uploaded_without_cutting_again() {
        let mut env = Fake::new(&["a"]);
        env.cached.insert("a".into());
        run_pass(&mut env, &mut State::default());
        assert_eq!(env.log, ["candidates", "upload a"]);
    }

    #[test]
    fn a_closed_gate_runs_nothing_and_shows_why_only_when_work_waits() {
        let mut env = Fake::new(&["a"]);
        env.gates.push_back(Gate::Closed {
            reason: "절약 모드",
            visible: true,
        });
        let mut state = State::default();
        assert_eq!(run_pass(&mut env, &mut state), Pass::Closed);
        assert!(
            env.log.is_empty() && env.reports.is_empty(),
            "no pending work is known yet"
        );
        state.pending = 4;
        env.gates.push_back(Gate::Closed {
            reason: "절약 모드",
            visible: true,
        });
        assert_eq!(run_pass(&mut env, &mut state), Pass::Closed);
        assert_eq!(env.reports, ["paused 절약 모드 4"]);
        env.gates.push_back(Gate::Closed {
            reason: "서버 게시 설정이 필요",
            visible: false,
        });
        env.reports.clear();
        run_pass(&mut env, &mut state);
        assert!(env.reports.is_empty());
    }

    #[test]
    fn the_gate_is_checked_before_every_image_and_stops_the_pass() {
        let mut env = Fake::new(&["a", "b", "c"]);
        env.gates.extend([
            Gate::Open,
            Gate::Open,
            Gate::Closed {
                reason: "절약 모드",
                visible: true,
            },
        ]);
        let mut state = State::default();
        assert_eq!(run_pass(&mut env, &mut state), Pass::Closed);
        assert_eq!(env.log, ["candidates", "make a", "upload a"]);
        assert_eq!(
            env.reports.last().map(String::as_str),
            Some("paused 절약 모드 2")
        );
    }

    #[test]
    fn a_failing_image_backs_off_while_the_rest_go_on() {
        let mut env = Fake::new(&["a", "b"]);
        env.broken.insert("a".into());
        let mut state = State::default();
        assert_eq!(
            run_pass(&mut env, &mut state),
            Pass::Worked {
                done: 1,
                failed: 1,
                more: false
            }
        );
        assert_eq!(state.failures_of("a"), 1);
        assert_eq!(env.reports.last().map(String::as_str), Some("queued 1"));
        // Still inside the backoff: the next pass leaves it alone.
        env.log.clear();
        assert_eq!(run_pass(&mut env, &mut state), Pass::Idle);
        assert!(!env.log.contains(&"make a".to_string()));
        // After the backoff it is tried again, and a second failure waits twice as long.
        env.clock += backoff(1) + Duration::from_secs(1);
        run_pass(&mut env, &mut state);
        assert!(env.log.contains(&"make a".to_string()));
        assert_eq!(state.failures_of("a"), 2);
        assert_eq!(
            state.delay(&Pass::Idle, env.clock),
            backoff(2).clamp(CLOSED_WAIT, IDLE_WAIT)
        );
        // Once it works, the record is gone.
        env.broken.clear();
        env.clock += backoff(2) + Duration::from_secs(1);
        run_pass(&mut env, &mut state);
        assert_eq!(state.failures_of("a"), 0);
    }

    #[test]
    fn an_upload_failure_keeps_the_cached_cutout_for_the_retry() {
        let mut env = Fake::new(&["a"]);
        env.upload_fail.insert("a".into());
        let mut state = State::default();
        run_pass(&mut env, &mut state);
        assert!(env.cached.contains("a"));
        env.upload_fail.clear();
        env.log.clear();
        env.clock += backoff(1) + Duration::from_secs(1);
        assert_eq!(
            run_pass(&mut env, &mut state),
            Pass::Worked {
                done: 1,
                failed: 0,
                more: false
            }
        );
        assert_eq!(env.log, ["candidates", "upload a"], "no second cut");
    }

    #[test]
    fn art_that_is_not_in_this_library_is_skipped_and_rechecked_later() {
        let mut env = Fake::new(&["gone", "here"]);
        env.not_local.insert("gone".into());
        let mut state = State::default();
        assert_eq!(
            run_pass(&mut env, &mut state),
            Pass::Worked {
                done: 1,
                failed: 0,
                more: false
            }
        );
        env.log.clear();
        run_pass(&mut env, &mut state);
        assert!(
            !env.log.contains(&"make gone".to_string()),
            "not asked again at once"
        );
        env.clock += NOT_LOCAL_RECHECK + Duration::from_secs(1);
        run_pass(&mut env, &mut state);
        assert!(env.log.contains(&"make gone".to_string()));
    }

    #[test]
    fn a_long_queue_is_taken_in_batches_and_the_list_is_read_again() {
        let ids: Vec<String> = (0..BATCH + 3).map(|n| format!("a{n}")).collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let mut env = Fake::new(&refs);
        let mut state = State::default();
        let first = run_pass(&mut env, &mut state);
        assert_eq!(
            first,
            Pass::Worked {
                done: BATCH as u64,
                failed: 0,
                more: true
            }
        );
        assert_eq!(state.delay(&first, env.clock), MORE_WAIT);
        assert_eq!(env.reports.last().map(String::as_str), Some("queued 3"));
    }

    #[test]
    fn a_fatal_error_ends_the_pass_with_a_visible_failure_and_a_long_wait() {
        let mut env = Fake::new(&["a", "b"]);
        env.fatal_upload = true;
        let mut state = State::default();
        let pass = run_pass(&mut env, &mut state);
        assert_eq!(pass, Pass::Failed);
        assert_eq!(
            env.reports.last().map(String::as_str),
            Some("failed unauthorized")
        );
        assert!(!env.log.contains(&"make b".to_string()));
        assert!(state.delay(&pass, env.clock) >= Duration::from_secs(5 * 60));
        let mut env = Fake::new(&["a"]);
        env.ids = Err("no network".into());
        assert_eq!(run_pass(&mut env, &mut state), Pass::Failed);
    }

    #[test]
    fn an_empty_list_finishes_quietly_and_waits_long() {
        let mut env = Fake::new(&[]);
        let mut state = State::default();
        let pass = run_pass(&mut env, &mut state);
        assert_eq!(pass, Pass::Idle);
        assert_eq!(env.reports, ["done"]);
        assert_eq!(state.delay(&pass, env.clock), IDLE_WAIT);
    }
}
