//! Opt-in local cover diagnostics. Never log media identities, paths or URLs.
use std::{
    cell::Cell,
    sync::OnceLock,
    time::{Duration, Instant},
};

#[derive(Clone, Copy)]
pub(crate) enum Stage {
    DatabaseWait = 0,
    DatabaseOpen = 1,
    ThumbnailQuery = 2,
    FileOpen = 3,
    FileRead = 4,
}

type Stages = [Duration; 5];
thread_local! {
    // Only the serving closure of an opted-in request enables this recorder.
    static STAGES: Cell<Option<Stages>> = const { Cell::new(None) };
}

pub(crate) struct StageTimer(Option<(Stage, Instant)>);

pub(crate) fn stage(stage: Stage) -> StageTimer {
    StageTimer(STAGES.with(|stages| stages.get().map(|_| (stage, Instant::now()))))
}

impl Drop for StageTimer {
    fn drop(&mut self) {
        if let Some((stage, started)) = self.0 {
            STAGES.with(|stages| {
                if let Some(mut values) = stages.get() {
                    values[stage as usize] += started.elapsed();
                    stages.set(Some(values));
                }
            });
        }
    }
}

struct StageScope(Option<Stages>);
impl Drop for StageScope {
    fn drop(&mut self) {
        STAGES.with(|stages| stages.set(self.0));
    }
}

pub(crate) struct MediaTiming {
    route: &'static str,
    requested: Instant,
    worker: Instant,
    waiting: Instant,
    stages: Stages,
    permitted: Instant,
}

impl MediaTiming {
    pub(crate) fn start(path: &str) -> Option<Self> {
        static ENABLED: OnceLock<bool> = OnceLock::new();
        if !*ENABLED.get_or_init(|| std::env::var("LAKOMICS_MEDIA_TIMING").as_deref() == Ok("1")) {
            return None;
        }
        cover_route(path).map(Self::new)
    }

    fn new(route: &'static str) -> Self {
        let now = Instant::now();
        Self {
            route,
            requested: now,
            worker: now,
            waiting: now,
            stages: [Duration::ZERO; 5],
            permitted: now,
        }
    }

    pub(crate) fn wait_started(&mut self) {
        self.waiting = Instant::now();
    }

    pub(crate) fn trace_serving<T>(&mut self, work: impl FnOnce() -> T) -> T {
        let _scope = StageScope(STAGES.with(|stages| stages.replace(Some([Duration::ZERO; 5]))));
        let result = work();
        self.stages = STAGES.with(|stages| stages.get().unwrap());
        result
    }

    pub(crate) fn worker_started(&mut self) {
        self.worker = Instant::now();
    }

    pub(crate) fn permit_acquired(&mut self) {
        self.permitted = Instant::now();
    }

    pub(crate) fn finish(self, status: u16, bytes: usize) {
        eprintln!("{}", self.report(Instant::now(), status, bytes));
    }

    fn report(&self, finished: Instant, status: u16, bytes: usize) -> String {
        format!(
            "w5:media route={} status={} bytes={} worker_queue_ms={:.3} permit_wait_ms={:.3} serve_ms={:.3} db_wait_ms={:.3} db_open_ms={:.3} thumbnail_query_ms={:.3} file_open_ms={:.3} file_read_ms={:.3}",
            self.route, status, bytes,
            (self.waiting.duration_since(self.requested) + self.worker.duration_since(self.permitted)).as_secs_f64() * 1000.0,
            self.permitted.duration_since(self.waiting).as_secs_f64() * 1000.0,
            finished.duration_since(self.worker).as_secs_f64() * 1000.0,
            self.stages[0].as_secs_f64() * 1000.0,
            self.stages[1].as_secs_f64() * 1000.0,
            self.stages[2].as_secs_f64() * 1000.0,
            self.stages[3].as_secs_f64() * 1000.0,
            self.stages[4].as_secs_f64() * 1000.0,
        )
    }
}

fn cover_route(path: &str) -> Option<&'static str> {
    [
        "work-artwork-thumbnail",
        "work-artwork",
        "collection-source-thumbnail",
        "collection-cover-thumbnail",
        "collection-source-preview",
        "collection-cover",
        "thumbnail",
    ]
    .into_iter()
    .find(|route| {
        path.strip_prefix('/')
            .and_then(|path| path.strip_prefix(route))
            .is_some_and(|rest| rest.starts_with('/'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn serving_stages_are_opt_in_and_do_not_leak_between_requests() {
        assert!(stage(Stage::DatabaseWait).0.is_none());
        let mut trace = MediaTiming::new("thumbnail");
        trace.trace_serving(|| {
            assert!(stage(Stage::DatabaseWait).0.is_some());
            // Fixed values check attribution without a wall-clock performance gate.
            STAGES.with(|stages| {
                stages.set(Some([
                    Duration::from_millis(2500),
                    Duration::from_millis(2),
                    Duration::from_millis(1),
                    Duration::from_millis(3),
                    Duration::from_millis(4),
                ]))
            });
        });
        assert!(trace.report(Instant::now(), 200, 19000).contains(
            "db_wait_ms=2500.000 db_open_ms=2.000 thumbnail_query_ms=1.000 file_open_ms=3.000 file_read_ms=4.000"));
        assert!(stage(Stage::DatabaseWait).0.is_none());
        trace.trace_serving(|| {});
        assert_eq!(trace.stages, [Duration::ZERO; 5]);
    }

    #[test]
    fn serving_scope_restores_disabled_recorder_after_panic() {
        assert!(std::panic::catch_unwind(|| {
            MediaTiming::new("thumbnail").trace_serving(|| panic!("failed read"));
        })
        .is_err());
        assert!(stage(Stage::FileRead).0.is_none());
    }

    #[test]
    fn reports_disjoint_phases_without_media_identity() {
        let requested = Instant::now();
        let trace = MediaTiming {
            route: cover_route("/work-artwork-thumbnail/private-id").unwrap(),
            requested,
            waiting: requested + Duration::from_millis(1),
            permitted: requested + Duration::from_millis(4),
            worker: requested + Duration::from_millis(5),
            stages: [Duration::ZERO; 5],
        };
        assert_eq!(trace.report(requested + Duration::from_millis(12), 200, 123),
            "w5:media route=work-artwork-thumbnail status=200 bytes=123 worker_queue_ms=2.000 permit_wait_ms=3.000 serve_ms=7.000 db_wait_ms=0.000 db_open_ms=0.000 thumbnail_query_ms=0.000 file_open_ms=0.000 file_read_ms=0.000");
        assert!(trace
            .report(requested + Duration::from_millis(12), 404, 0)
            .contains("status=404 bytes=0"));
    }

    #[test]
    fn excludes_remote_and_private_vault_routes() {
        for path in [
            "/vault-thumbnail/id",
            "/remote-manga-thumbnail/id",
            "/asset/id",
            "/thumbnail-extra/id",
        ] {
            assert_eq!(cover_route(path), None);
        }
        assert_eq!(
            cover_route("/collection-source-thumbnail/id"),
            Some("collection-source-thumbnail")
        );
    }
}
