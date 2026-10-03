//! Reserve local I/O capacity for each route class, before starting blocking work.
//! Tauri's UriSchemeResponder has no abort notification. Removing an img does not
//! cancel this task through the current API, so isolation must not depend on it.
use std::sync::{Arc, OnceLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

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

struct Pools([Arc<Semaphore>; 3]);

impl Pools {
    fn new(slots: [usize; 3]) -> Self {
        Self(slots.map(|slots| Arc::new(Semaphore::new(slots))))
    }

    async fn acquire(&self, path: &str) -> Option<OwnedSemaphorePermit> {
        let class = route_class(path)?;
        // Tokio removes dropped acquisition futures from its FIFO queue. There is
        // no blocking thread or work closure to run for a cancelled queued future.
        Some(
            self.0[class as usize]
                .clone()
                .acquire_owned()
                .await
                .expect("media permit pools are never closed"),
        )
    }
}

pub(crate) async fn acquire(path: &str) -> Option<OwnedSemaphorePermit> {
    static POOLS: OnceLock<Pools> = OnceLock::new();
    POOLS.get_or_init(|| Pools::new(crate::performance::budgets().media_slots)).acquire(path).await
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
    fn profile_pools_keep_each_class_bounded_and_retain_permits_until_work_finishes() {
        for profile in [crate::performance::Profile::Laptop, crate::performance::Profile::Main] {
            let slots = profile.budgets().media_slots;
            let pools = Pools::new(slots);
            let mut held = Vec::new();
            for (index, route) in ["/thumbnail/a", "/manga-cover/a", "/asset/a"].into_iter().enumerate() {
                for _ in 0..slots[index] {
                    held.push(ready(poll(Box::pin(pools.acquire(route)).as_mut())));
                }
                let mut waiting = Box::pin(pools.acquire(route));
                assert!(poll(waiting.as_mut()).is_pending());
                drop(waiting);
            }
            assert_eq!(held.len(), slots.iter().sum::<usize>());
            assert!(ready(poll(Box::pin(pools.acquire("/remote-manga-page/a")).as_mut())).is_none());
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
