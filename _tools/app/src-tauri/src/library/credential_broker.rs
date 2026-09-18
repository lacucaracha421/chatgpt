//! Process-session owner of the cloud credentials.
//!
//! # The defect this exists for
//!
//! Every cloud worker used to call the OS credential store directly, once per cycle:
//! capture polling, metadata publication, replication, and the authority outboxes all
//! began a pass by reading a token. On Linux that read goes through the desktop Secret
//! Service, and `check_collection` deliberately refuses to unlock it, so a transient
//! GNOME Keyring lock or daemon restart turned a healthy library into a set of failing
//! workers. The measured cost was complete, not degraded: on 2026-09-18 22:44 KST a
//! capture the server had accepted (with its R2 inbox object already present) was never
//! fetched, because the capture poll failed *before* its HTTP request - the credential
//! read happens first, so the failure produced no `/v1/captures/pending` call at all,
//! and the same lock stopped mobile metadata publication.
//!
//! # The model
//!
//! One broker per application process, holding at most one cached secret per credential
//! target. The OS credential store remains the only at-rest storage; nothing here is
//! persisted, so a process restart always returns to the store. What changes is the
//! lifetime of a value the process has already legitimately obtained: it is reused for
//! the rest of the process instead of being re-fetched per worker cycle, so a later
//! keyring lock cannot interrupt a worker that already holds a valid credential.
//!
//! # Boundaries
//!
//! * A **cold** process with a locked keyring is still blocked, and no background read
//!   ever summons an unlock dialog. The broker is not an unlock mechanism.
//! * A **warm** process keeps running across a lock; that is the regression being fixed.
//! * A definitive authentication rejection invalidates the affected cached target,
//!   because retrying a refused bearer forever is both useless and wrong. A timeout,
//!   `5xx`, or transport error does **not** invalidate: the credential is still presumed
//!   good and the failure is ordinary and retryable.
//!
//! The tradeoff is deliberate: a cached bearer lives in this process's memory for the
//! process lifetime rather than for one worker cycle. That is the price of not coupling
//! background cloud operation to desktop keyring locking, and it stores nothing new at
//! rest.

use std::fmt;
use std::sync::{LazyLock, Mutex, PoisonError};

use super::credential::{self, CloudCredential, CredentialBackend, CredentialTarget, OsCredentialBackend};
use super::error::LibraryError;

/// One cached secret and the single-flight gate that guards loading it.
///
/// A cache miss must perform *at most one* Secret Service read even when several workers
/// miss simultaneously (capture, metadata and replication each start passes on their own
/// schedules). The gate therefore holds its mutex across the backend read *and* the
/// store: the read is a bounded local IPC call with its own deadline, not network I/O,
/// so serializing concurrent misses is the entire point. No network call is ever made
/// while this lock is held.
///
/// Zeroing on drop is best-effort - a copy taken elsewhere or moved by the allocator may
/// outlive this value - so it narrows, but does not close, the window in which the token
/// is present in freed memory.
#[derive(Default)]
struct TargetCache {
    cached: Mutex<Option<CloudCredential>>,
}

impl TargetCache {
    /// Whether a credential is currently cached. Deliberately does not copy it: this
    /// exists for `Debug`, which must not clone a secret to report its presence.
    fn is_cached(&self) -> bool {
        self.cached
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }

    /// Return the cached credential, or load, cache and return it. Exactly one load per
    /// miss, because the guard is held across it.
    fn get_or_load<B: CredentialBackend>(
        &self,
        backend: &B,
        target: CredentialTarget,
    ) -> Result<CloudCredential, LibraryError> {
        let mut cached = self.cached.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(existing) = cached.as_ref() {
            return Ok(existing.duplicate());
        }
        let loaded = credential::read_secret_for(backend, target)?;
        *cached = Some(loaded.duplicate());
        Ok(loaded)
    }

    /// Drop the cached value, zeroing the buffer it held.
    fn clear(&self) {
        let mut cached = self.cached.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(previous) = cached.take() {
            drop(previous);
        }
    }
}

/// A credential owner shared by every cloud worker in one process.
///
/// The two targets are separate fields rather than a map: there are exactly two, they
/// are cached and invalidated independently on purpose, and naming them keeps the
/// lookup infallible.
pub(crate) struct CredentialBroker<B: CredentialBackend> {
    backend: B,
    cloud_api: TargetCache,
    cloud_publisher: TargetCache,
}

impl<B: CredentialBackend> fmt::Debug for CredentialBroker<B> {
    /// Reports only whether each target is currently cached. Never the values.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CredentialBroker")
            .field("cloud_api_cached", &self.cloud_api.is_cached())
            .field("cloud_publisher_cached", &self.cloud_publisher.is_cached())
            .finish()
    }
}

impl<B: CredentialBackend> CredentialBroker<B> {
    pub(crate) fn new(backend: B) -> Self {
        Self {
            backend,
            cloud_api: TargetCache::default(),
            cloud_publisher: TargetCache::default(),
        }
    }

    fn cache(&self, target: CredentialTarget) -> &TargetCache {
        match target {
            CredentialTarget::CloudApi => &self.cloud_api,
            CredentialTarget::CloudPublisher => &self.cloud_publisher,
        }
    }

    /// The credential for `target`, loading it from the OS store on the first request.
    ///
    /// A cached value is returned without touching the backend, so a worker that already
    /// has one keeps working after the keyring locks. A *cold* miss propagates the
    /// store's error unchanged - notably [`LibraryError::CredentialStoreLocked`] rather
    /// than a generic connectivity message - so the caller can record why it stopped.
    pub(crate) fn credential(&self, target: CredentialTarget) -> Result<CloudCredential, LibraryError> {
        self.cache(target).get_or_load(&self.backend, target)
    }

    /// Discard the cached credential for `target`, forcing the next request to read the
    /// store again.
    ///
    /// Called when the credential is replaced or deleted, and on a definitive server
    /// authentication rejection. Never called for retryable failures: a timeout or `5xx`
    /// says nothing about whether the credential is still valid.
    pub(crate) fn invalidate(&self, target: CredentialTarget) {
        self.cache(target).clear();
    }

    /// Invalidate `target` when `error` is a definitive authentication rejection.
    ///
    /// Retrying a bearer the server has refused cannot succeed, so the refused value is
    /// dropped and the next attempt re-reads the store. Only the *affected* target is
    /// dropped: invalidating both would let one lane's rejection force an unrelated lane
    /// back to the store, which is exactly the coupling this module exists to remove.
    ///
    /// Returns whether the cache was invalidated, so callers can assert the distinction
    /// between an authentication rejection and an ordinary retryable failure.
    pub(crate) fn invalidate_on_auth_rejection(
        &self,
        target: CredentialTarget,
        error: &LibraryError,
    ) -> bool {
        if matches!(error, LibraryError::CloudUnauthorized) {
            self.invalidate(target);
            true
        } else {
            false
        }
    }
}

/// The process-wide broker over the real OS credential store.
///
/// Process-wide rather than a field on `Library` because the credential is a property of
/// this process's access to the desktop session, not of one library directory: the same
/// keyring backs every library the process opens, and two `Library` handles must not each
/// hold a private copy of the same secret. Workers that need a different backend (tests)
/// construct their own [`CredentialBroker`] directly instead of mutating this one.
static BROKER: LazyLock<CredentialBroker<OsCredentialBackend>> =
    LazyLock::new(|| CredentialBroker::new(OsCredentialBackend));

/// The shared broker for cloud API and cloud publisher credentials.
pub(crate) fn broker() -> &'static CredentialBroker<OsCredentialBackend> {
    &BROKER
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::credential::test_support::CountingBackend;

    const CLOUD_API: &str = "Lakomics/CloudApi";
    const CLOUD_PUBLISHER: &str = "Lakomics/CloudPublisher";

    fn unlocked() -> CountingBackend {
        let backend = CountingBackend::default();
        backend.set(CLOUD_API, "client-credential");
        backend.set(CLOUD_PUBLISHER, "publisher-credential");
        backend
    }

    #[test]
    fn one_backend_read_serves_many_worker_cycles() {
        let backend = unlocked();
        let broker = CredentialBroker::new(backend.clone());

        assert_eq!(broker.credential(CredentialTarget::CloudApi).unwrap().expose(), "client-credential");
        for _ in 0..100 {
            assert_eq!(broker.credential(CredentialTarget::CloudApi).unwrap().expose(), "client-credential");
        }
        assert_eq!(backend.read_count(CLOUD_API), 1);
    }

    #[test]
    fn caches_each_target_independently() {
        let backend = unlocked();
        let broker = CredentialBroker::new(backend.clone());

        assert_eq!(broker.credential(CredentialTarget::CloudApi).unwrap().expose(), "client-credential");
        assert_eq!(broker.credential(CredentialTarget::CloudPublisher).unwrap().expose(), "publisher-credential");
        // Holding one credential must never satisfy a request for the other.
        assert_eq!(backend.read_count(CLOUD_API), 1);
        assert_eq!(backend.read_count(CLOUD_PUBLISHER), 1);
    }

    #[test]
    fn continues_from_cache_after_the_keyring_locks() {
        let backend = unlocked();
        let broker = CredentialBroker::new(backend.clone());
        broker.credential(CredentialTarget::CloudApi).unwrap();

        // The keyring locks, or its daemon restarts, after the first successful load.
        backend.lock();
        // Capture, metadata and replication cycles all keep getting the credential, and
        // no further store read is attempted.
        for _ in 0..3 {
            assert_eq!(broker.credential(CredentialTarget::CloudApi).unwrap().expose(), "client-credential");
        }
        assert_eq!(backend.read_count(CLOUD_API), 1);
    }

    #[test]
    fn a_cold_locked_store_reports_locked_and_retries_next_time() {
        let backend = CountingBackend::default();
        backend.set(CLOUD_API, "client-credential");
        backend.lock();
        let broker = CredentialBroker::new(backend.clone());

        assert!(matches!(
            broker.credential(CredentialTarget::CloudApi),
            Err(LibraryError::CredentialStoreLocked)
        ));
        // A failed load caches nothing, so the first failure cannot poison later attempts.
        assert!(matches!(
            broker.credential(CredentialTarget::CloudApi),
            Err(LibraryError::CredentialStoreLocked)
        ));
        assert_eq!(backend.read_count(CLOUD_API), 2);
    }

    #[test]
    fn concurrent_first_requests_collapse_into_one_backend_read() {
        let backend = unlocked();
        let broker = std::sync::Arc::new(CredentialBroker::new(backend.clone()));

        let handles: Vec<_> = (0..16)
            .map(|_| {
                let broker = std::sync::Arc::clone(&broker);
                std::thread::spawn(move || {
                    broker
                        .credential(CredentialTarget::CloudApi)
                        .unwrap()
                        .expose()
                        .to_owned()
                })
            })
            .collect();
        for handle in handles {
            assert_eq!(handle.join().unwrap(), "client-credential");
        }
        // Sixteen simultaneous misses, one Secret Service read.
        assert_eq!(backend.read_count(CLOUD_API), 1);
    }

    #[test]
    fn invalidate_forces_a_fresh_read_and_surfaces_the_new_value() {
        let backend = unlocked();
        let broker = CredentialBroker::new(backend.clone());
        assert_eq!(broker.credential(CredentialTarget::CloudApi).unwrap().expose(), "client-credential");

        backend.set(CLOUD_API, "replacement-credential");
        // The store changed but this process was not told, so the process-session value
        // still stands: replacement is a deliberate invalidation, not a silent re-read.
        assert_eq!(broker.credential(CredentialTarget::CloudApi).unwrap().expose(), "client-credential");

        broker.invalidate(CredentialTarget::CloudApi);
        assert_eq!(broker.credential(CredentialTarget::CloudApi).unwrap().expose(), "replacement-credential");
        assert_eq!(backend.read_count(CLOUD_API), 2);
    }

    #[test]
    fn invalidating_one_target_leaves_the_other_cached() {
        let backend = unlocked();
        let broker = CredentialBroker::new(backend.clone());
        broker.credential(CredentialTarget::CloudApi).unwrap();
        broker.credential(CredentialTarget::CloudPublisher).unwrap();

        broker.invalidate(CredentialTarget::CloudApi);

        assert_eq!(broker.credential(CredentialTarget::CloudPublisher).unwrap().expose(), "publisher-credential");
        assert_eq!(backend.read_count(CLOUD_PUBLISHER), 1);
        assert_eq!(broker.credential(CredentialTarget::CloudApi).unwrap().expose(), "client-credential");
        assert_eq!(backend.read_count(CLOUD_API), 2);
    }

    #[test]
    fn a_deleted_credential_is_not_served_from_cache_after_invalidation() {
        let backend = unlocked();
        let broker = CredentialBroker::new(backend.clone());
        broker.credential(CredentialTarget::CloudApi).unwrap();

        backend.delete(CLOUD_API);
        broker.invalidate(CredentialTarget::CloudApi);

        assert!(matches!(
            broker.credential(CredentialTarget::CloudApi),
            Err(LibraryError::CloudCredentialNotConfigured)
        ));
    }

    #[test]
    fn only_auth_rejection_invalidates_a_cached_credential() {
        let backend = unlocked();
        let broker = CredentialBroker::new(backend.clone());
        broker.credential(CredentialTarget::CloudApi).unwrap();

        // Ordinary retryable failures must leave the session credential in place.
        for retryable in [
            LibraryError::CloudRequestTimedOut,
            LibraryError::CloudRequestUnavailable,
            LibraryError::CloudUploadRejected(503),
            LibraryError::CloudPresignRejected(500),
        ] {
            assert!(!broker.invalidate_on_auth_rejection(CredentialTarget::CloudApi, &retryable), "{retryable}");
            assert_eq!(broker.credential(CredentialTarget::CloudApi).unwrap().expose(), "client-credential");
        }
        assert_eq!(backend.read_count(CLOUD_API), 1);

        // A definitive rejection does, and only for the refused target. The proof that
        // the cache was actually dropped is that the next request goes back to the store.
        assert!(broker.invalidate_on_auth_rejection(CredentialTarget::CloudApi, &LibraryError::CloudUnauthorized));
        assert_eq!(broker.credential(CredentialTarget::CloudApi).unwrap().expose(), "client-credential");
        assert_eq!(backend.read_count(CLOUD_API), 2);
    }

    #[test]
    fn debug_output_never_contains_the_secret() {
        let backend = unlocked();
        let broker = CredentialBroker::new(backend.clone());
        let credential = broker.credential(CredentialTarget::CloudApi).unwrap();

        for rendered in [format!("{credential:?}"), format!("{broker:?}")] {
            assert!(!rendered.contains("client-credential"), "{rendered}");
            assert!(!rendered.contains("publisher-credential"), "{rendered}");
        }
    }

    #[test]
    fn a_locked_store_never_yields_a_credential_and_never_unlocks() {
        let backend = CountingBackend::default();
        backend.set(CLOUD_PUBLISHER, "publisher-credential");
        backend.lock();
        let broker = CredentialBroker::new(backend.clone());

        // Both targets are cold, so publication is blocked too - the broker is not an
        // unlock mechanism, and a locked store is a real failure, not a silent bypass.
        assert!(matches!(
            broker.credential(CredentialTarget::CloudPublisher),
            Err(LibraryError::CredentialStoreLocked)
        ));
        assert_eq!(backend.read_count(CLOUD_PUBLISHER), 1);
    }
}
