//! Reserve local I/O capacity for each route class, before starting blocking work.
//! Tauri's UriSchemeResponder has no abort notification. Requests from departed
//! views remain valid, but newer view generations get slots first (FIFO on ties).
//! Dropped acquisition futures leave the queue without leaking reserved capacity.
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};
use tokio::sync::oneshot;

static VIEW_GENERATION: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub(crate) fn media_view_changed() {
    VIEW_GENERATION.fetch_add(1, Ordering::Relaxed);
}

// A departed Asset grid cannot occupy cover or original/playback slots.
#[cfg(test)]
const SLOTS_PER_CLASS: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Class {
    AssetThumbnail = 0,
    Cover = 1,
    Original = 2,
}

fn route_class(path: &str) -> Option<Class> {
    if [
        "/igdb-image-preview/",
        "/tmdb-image-preview/",
        "/remote-manga-",
        "/remote-catalog-thumbnail/",
        "/mangadex-cover-preview/",
    ]
    .iter()
    .any(|prefix| path.starts_with(prefix))
    {
        return None;
    }
    let route = path
        .strip_prefix('/')
        .unwrap_or(path)
        .split('/')
        .next()
        .unwrap_or("");
    Some(match route {
        "thumbnail" | "trash-thumbnail" | "vault-thumbnail" | "scrub-frame" => {
            Class::AssetThumbnail
        }
        "work-artwork-thumbnail"
        | "collection-source-thumbnail"
        | "collection-cover-thumbnail"
        | "manga-cover"
        | "av-link-jacket" => Class::Cover,
        _ => Class::Original,
    })
}

struct Waiter {
    id: u64,
    generation: u64,
    sender: oneshot::Sender<Permit>,
}

struct State {
    available: usize,
    next_id: u64,
    waiters: Vec<Waiter>,
}

struct Pool(Mutex<State>);

pub(crate) struct Permit(Arc<Pool>);

impl Drop for Permit {
    fn drop(&mut self) {
        let next = {
            let mut state = self.0 .0.lock().unwrap();
            // Strict comparison preserves arrival order within a generation.
            let mut best = None;
            for (index, waiter) in state.waiters.iter().enumerate() {
                if best.is_none_or(|current: usize| {
                    waiter.generation > state.waiters[current].generation
                }) {
                    best = Some(index);
                }
            }
            if let Some(index) = best {
                Some(state.waiters.remove(index).sender)
            } else {
                state.available += 1;
                None
            }
        };
        if let Some(sender) = next {
            // Send outside the lock: a cancelled receiver drops this permit and
            // hands the slot to the next waiter. No slot is freed between owners.
            let _ = sender.send(Permit(self.0.clone()));
        }
    }
}

struct Queued {
    pool: Arc<Pool>,
    id: u64,
}

impl Drop for Queued {
    fn drop(&mut self) {
        let mut state = self.pool.0.lock().unwrap();
        if let Some(index) = state.waiters.iter().position(|waiter| waiter.id == self.id) {
            state.waiters.remove(index);
        }
        // If already handed off, the receiver owns the reserved permit and
        // releases it even when cancelled before its next poll.
    }
}

impl Pool {
    async fn acquire(self: Arc<Self>, generation: u64) -> Permit {
        let (receiver, _queued) = {
            let mut state = self.0.lock().unwrap();
            if state.available > 0 {
                state.available -= 1;
                return Permit(self.clone());
            }
            let id = state.next_id;
            state.next_id += 1;
            let (sender, receiver) = oneshot::channel();
            state.waiters.push(Waiter {
                id,
                generation,
                sender,
            });
            (
                receiver,
                Queued {
                    pool: self.clone(),
                    id,
                },
            )
        };
        receiver.await.expect("media permit pools are never closed")
    }

    #[cfg(test)]
    fn available_permits(&self) -> usize {
        self.0.lock().unwrap().available
    }
}

struct Pools([Arc<Pool>; 3]);

impl Pools {
    fn new(slots: [usize; 3]) -> Self {
        Self(slots.map(|available| {
            Arc::new(Pool(Mutex::new(State {
                available,
                next_id: 0,
                waiters: Vec::new(),
            })))
        }))
    }

    fn acquire(&self, path: &str) -> impl std::future::Future<Output = Option<Permit>> + '_ {
        self.acquire_generation(path, VIEW_GENERATION.load(Ordering::Relaxed))
    }

    fn acquire_generation(
        &self,
        path: &str,
        generation: u64,
    ) -> impl std::future::Future<Output = Option<Permit>> + '_ {
        let pool = route_class(path).map(|class| self.0[class as usize].clone());
        async move {
            match pool {
                Some(pool) => Some(pool.acquire(generation).await),
                None => None,
            }
        }
    }
}

pub(crate) fn acquire(path: &str) -> impl std::future::Future<Output = Option<Permit>> {
    static POOLS: OnceLock<Pools> = OnceLock::new();
    POOLS
        .get_or_init(|| Pools::new(crate::performance::budgets().media_slots))
        .acquire(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        pin::Pin,
        sync::atomic::{AtomicBool, Ordering},
        task::{Context, Poll, Wake, Waker},
    };

    struct Noop;
    impl Wake for Noop {
        fn wake(self: Arc<Self>) {}
    }
    fn poll<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
        future.poll(&mut Context::from_waker(&Waker::from(Arc::new(Noop))))
    }
    fn ready<T>(value: Poll<T>) -> T {
        match value {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("unexpected queue wait"),
        }
    }

    #[test]
    fn newer_generation_overtakes_old_waiters_and_old_work_still_finishes() {
        let pools = Pools::new([1; 3]);
        let held = ready(poll(
            Box::pin(pools.acquire_generation("/thumbnail/a", 0)).as_mut(),
        ));
        let mut older = Box::pin(pools.acquire_generation("/thumbnail/old", 1));
        let mut oldest = Box::pin(pools.acquire_generation("/thumbnail/oldest", 0));
        let mut newer = Box::pin(pools.acquire_generation("/thumbnail/new", 2));
        assert!(poll(older.as_mut()).is_pending());
        assert!(poll(oldest.as_mut()).is_pending());
        assert!(poll(newer.as_mut()).is_pending());
        drop(held);
        assert!(poll(older.as_mut()).is_pending());
        assert!(poll(oldest.as_mut()).is_pending());
        let next = ready(poll(newer.as_mut()));
        drop(next);
        assert!(poll(oldest.as_mut()).is_pending());
        drop(ready(poll(older.as_mut())));
        drop(ready(poll(oldest.as_mut())));
        assert_eq!(pools.0[0].available_permits(), 1);
    }

    #[test]
    fn one_generation_keeps_fifo_order() {
        let pools = Pools::new([1; 3]);
        let held = ready(poll(
            Box::pin(pools.acquire_generation("/thumbnail/a", 7)).as_mut(),
        ));
        let mut first = Box::pin(pools.acquire_generation("/thumbnail/b", 7));
        let mut second = Box::pin(pools.acquire_generation("/thumbnail/c", 7));
        assert!(poll(first.as_mut()).is_pending());
        assert!(poll(second.as_mut()).is_pending());
        drop(held);
        assert!(poll(second.as_mut()).is_pending());
        drop(ready(poll(first.as_mut())));
        drop(ready(poll(second.as_mut())));
        assert_eq!(pools.0[0].available_permits(), 1);
    }

    #[test]
    fn cancellation_before_and_after_handoff_preserves_capacity() {
        let pools = Pools::new([1; 3]);
        let held = ready(poll(Box::pin(pools.acquire("/thumbnail/a")).as_mut()));
        let mut cancelled = Box::pin(pools.acquire("/thumbnail/b"));
        assert!(poll(cancelled.as_mut()).is_pending());
        drop(cancelled);
        assert_eq!(pools.0[0].available_permits(), 0);
        assert!(pools.0[0].0.lock().unwrap().waiters.is_empty());
        let mut assigned = Box::pin(pools.acquire("/thumbnail/c"));
        let mut next = Box::pin(pools.acquire("/thumbnail/d"));
        assert!(poll(assigned.as_mut()).is_pending());
        assert!(poll(next.as_mut()).is_pending());
        drop(held);
        // Cancellation after waking, but before polling, returns the reserved slot.
        drop(assigned);
        drop(ready(poll(next.as_mut())));
        assert_eq!(pools.0[0].available_permits(), 1);
    }

    #[test]
    fn bypass_routes_never_enter_full_queues() {
        let pools = Pools::new([0; 3]);
        assert!(ready(poll(
            Box::pin(pools.acquire("/remote-manga-page/a")).as_mut()
        ))
        .is_none());
        for pool in &pools.0 {
            assert!(pool.0.lock().unwrap().waiters.is_empty());
            assert_eq!(pool.available_permits(), 0);
        }
    }

    #[test]
    fn profile_pools_keep_each_class_bounded_and_retain_permits_until_work_finishes() {
        for profile in [
            crate::performance::Profile::Laptop,
            crate::performance::Profile::Main,
        ] {
            let slots = profile.budgets().media_slots;
            let pools = Pools::new(slots);
            let mut held = Vec::new();
            for (index, route) in ["/thumbnail/a", "/manga-cover/a", "/asset/a"]
                .into_iter()
                .enumerate()
            {
                for _ in 0..slots[index] {
                    held.push(ready(poll(Box::pin(pools.acquire(route)).as_mut())));
                }
                let mut waiting = Box::pin(pools.acquire(route));
                assert!(poll(waiting.as_mut()).is_pending());
                drop(waiting);
            }
            assert_eq!(held.len(), slots.iter().sum::<usize>());
            assert!(ready(poll(
                Box::pin(pools.acquire("/remote-manga-page/a")).as_mut()
            ))
            .is_none());
            drop(held);
            for (pool, count) in pools.0.iter().zip(slots) {
                assert_eq!(pool.available_permits(), count);
            }
        }
    }

    #[test]
    fn covers_and_originals_start_while_many_asset_requests_wait() {
        let pools = Pools::new(crate::performance::Profile::Laptop.budgets().media_slots);
        let mut held = Vec::new();
        for _ in 0..SLOTS_PER_CLASS {
            held.push(ready(poll(
                Box::pin(pools.acquire("/thumbnail/id")).as_mut(),
            )));
        }
        let mut queued: Vec<_> = (0..64)
            .map(|_| Box::pin(pools.acquire("/thumbnail/id")))
            .collect();
        for future in &mut queued {
            assert!(poll(future.as_mut()).is_pending());
        }
        for route in [
            "/work-artwork-thumbnail/id",
            "/collection-source-thumbnail/id",
            "/collection-cover-thumbnail/id/file",
            "/asset/id",
            "/playback/id",
        ] {
            assert!(
                ready(poll(Box::pin(pools.acquire(route)).as_mut())).is_some(),
                "{route}"
            );
        }
        // Original and cover capacity are bounded as well: total local capacity is six.
        for route in ["/work-artwork-thumbnail/id", "/asset/id"] {
            for _ in 0..SLOTS_PER_CLASS {
                held.push(ready(poll(Box::pin(pools.acquire(route)).as_mut())));
            }
            assert!(poll(Box::pin(pools.acquire(route)).as_mut()).is_pending());
        }
        assert_eq!(held.len(), 6);
        assert!(ready(poll(
            Box::pin(pools.acquire("/remote-manga-page/id/1")).as_mut()
        ))
        .is_none());
        drop(held);
        for future in &mut queued {
            drop(ready(poll(future.as_mut())));
        }
        for pool in &pools.0 {
            assert_eq!(pool.available_permits(), SLOTS_PER_CLASS);
        }
    }

    #[test]
    fn cancelling_queued_work_removes_waiter_and_never_runs_it() {
        let pools = Pools::new(crate::performance::Profile::Laptop.budgets().media_slots);
        let held: Vec<_> = (0..SLOTS_PER_CLASS)
            .map(|_| ready(poll(Box::pin(pools.acquire("/thumbnail/id")).as_mut())))
            .collect();
        let ran = AtomicBool::new(false);
        let mut cancelled = Box::pin(async {
            let _permit = pools.acquire("/thumbnail/id").await;
            ran.store(true, Ordering::SeqCst);
        });
        assert!(poll(cancelled.as_mut()).is_pending());
        let mut next = Box::pin(pools.acquire("/thumbnail/next"));
        assert!(poll(next.as_mut()).is_pending());
        drop(cancelled);
        drop(held);
        drop(ready(poll(next.as_mut())));
        assert!(!ran.load(Ordering::SeqCst));
        assert_eq!(
            pools.0[Class::AssetThumbnail as usize].available_permits(),
            SLOTS_PER_CLASS
        );
    }

    #[test]
    fn permits_release_on_error_and_unwind() {
        let pools = Pools::new(crate::performance::Profile::Laptop.budgets().media_slots);
        let work = || -> Result<(), ()> {
            let _permit = ready(poll(Box::pin(pools.acquire("/asset/id")).as_mut()));
            Err(())
        };
        assert!(work().is_err());
        assert!(std::panic::catch_unwind(|| {
            let _permit = ready(poll(Box::pin(pools.acquire("/asset/id")).as_mut()));
            panic!("failed work");
        })
        .is_err());
        assert_eq!(
            pools.0[Class::Original as usize].available_permits(),
            SLOTS_PER_CLASS
        );
    }

    #[test]
    fn route_classes_keep_remote_bypass_and_exact_thumbnail_boundaries() {
        for route in [
            "/igdb-image-preview/cover/id",
            "/tmdb-image-preview/poster/id",
            "/remote-manga-thumbnail/id",
            "/remote-catalog-thumbnail/kHentai/id",
            "/mangadex-cover-preview/id/file",
        ] {
            assert_eq!(route_class(route), None);
        }
        assert_eq!(route_class("/thumbnail-extra/id"), Some(Class::Original));
        assert_eq!(route_class("/work-artwork/id"), Some(Class::Original));
        assert_eq!(
            route_class("/vault-thumbnail/id/v3"),
            Some(Class::AssetThumbnail)
        );
    }
}
