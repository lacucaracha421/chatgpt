//! Persistent Linux credentials through the desktop Secret Service. No file or
//! session-only fallback; key bytes never become item labels or search attributes.
use std::{collections::HashMap, future::Future, time::Duration};

use secret_service::{EncryptionType, SecretService};

use super::{CredentialBackend, CredentialError};

pub(super) struct LinuxCredentialBackend;
const OPERATION_TIMEOUT: Duration = Duration::from_secs(10);
const APPLICATION: &str = "com.lakomics.desktop";

fn attributes(target: &str) -> HashMap<&str, &str> {
    HashMap::from([("application", APPLICATION), ("target", target)])
}

fn map_error(error: secret_service::Error) -> CredentialError {
    match error {
        secret_service::Error::Locked => CredentialError::Locked,
        secret_service::Error::Unavailable | secret_service::Error::NoResult => {
            CredentialError::Unavailable
        }
        // Never propagate D-Bus diagnostics, which can contain credential metadata.
        _ => CredentialError::System(0),
    }
}

fn bounded<T>(
    future: impl Future<Output = Result<T, CredentialError>>,
) -> Result<T, CredentialError> {
    bounded_with_timeout(future, OPERATION_TIMEOUT)
}

fn bounded_with_timeout<T>(
    future: impl Future<Output = Result<T, CredentialError>>,
    timeout: Duration,
) -> Result<T, CredentialError> {
    // async-io has its own reactor, so synchronous credential callers do not need
    // a nested Tokio runtime. The deadline also bounds any keyring authorization prompt.
    async_io::block_on(futures_lite::future::or(future, async {
        async_io::Timer::after(timeout).await;
        Err(CredentialError::System(0))
    }))
}

impl CredentialBackend for LinuxCredentialBackend {
    fn read(&self, target: &str) -> Result<Option<Vec<u8>>, CredentialError> {
        bounded(async {
            let service = SecretService::connect(EncryptionType::Dh)
                .await
                .map_err(map_error)?;
            let collection = service.get_default_collection().await.map_err(map_error)?;
            check_collection(&collection).await?;
            let items = collection
                .search_items(attributes(target))
                .await
                .map_err(map_error)?;
            // Ambiguous entries must not silently choose an arbitrary Notes key.
            match items.as_slice() {
                [] => Ok(None),
                [item] => item.get_secret().await.map(Some).map_err(map_error),
                _ => Err(CredentialError::System(0)),
            }
        })
    }

    fn write(&self, target: &str, value: &[u8]) -> Result<(), CredentialError> {
        bounded(async {
            let service = SecretService::connect(EncryptionType::Dh)
                .await
                .map_err(map_error)?;
            let collection = service.get_default_collection().await.map_err(map_error)?;
            check_collection(&collection).await?;
            collection
                .create_item(
                    "Lakomics",
                    attributes(target),
                    value,
                    true,
                    "application/octet-stream",
                )
                .await
                .map_err(map_error)?;
            Ok(())
        })
    }

    fn delete(&self, target: &str) -> Result<(), CredentialError> {
        bounded(async {
            let service = SecretService::connect(EncryptionType::Dh)
                .await
                .map_err(map_error)?;
            let collection = service.get_default_collection().await.map_err(map_error)?;
            check_collection(&collection).await?;
            for item in collection
                .search_items(attributes(target))
                .await
                .map_err(map_error)?
            {
                item.delete().await.map_err(map_error)?;
            }
            Ok(())
        })
    }
}

async fn check_collection(
    collection: &secret_service::Collection<'_>,
) -> Result<(), CredentialError> {
    if collection.collection_path.as_str() == "/org/freedesktop/secrets/collection/session" {
        return Err(CredentialError::Unavailable);
    }
    // Background reads never unlock the keyring or trigger an unlock dialog.
    collection.ensure_unlocked().await.map_err(map_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::error::LibraryError;

    #[test]
    fn errors_are_actionable_and_never_expose_backend_details() {
        assert!(matches!(
            super::super::map_backend_error(map_error(secret_service::Error::Locked)),
            LibraryError::CredentialStoreLocked
        ));
        assert!(matches!(
            super::super::map_backend_error(map_error(secret_service::Error::Unavailable)),
            LibraryError::CredentialStoreUnavailable
        ));
        assert!(matches!(
            super::super::map_backend_error(map_error(secret_service::Error::Crypto(
                "must-not-leak"
            ))),
            LibraryError::CredentialStoreFailed
        ));
    }

    #[test]
    fn backend_deadline_cancels_a_stalled_operation() {
        let started = std::time::Instant::now();
        let result: Result<(), _> =
            bounded_with_timeout(std::future::pending(), Duration::from_millis(30));
        assert!(matches!(result, Err(CredentialError::System(_))));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    #[ignore = "writes only UUID-isolated synthetic credentials to the native Linux keyring"]
    fn native_linux_keyring_roundtrip() {
        let target = format!("Lakomics/Test/{}", uuid::Uuid::new_v4());
        let other = format!("Lakomics/Test/{}", uuid::Uuid::new_v4());
        struct Cleanup(Vec<String>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                for target in &self.0 {
                    let _ = LinuxCredentialBackend.delete(target);
                }
            }
        }
        let _cleanup = Cleanup(vec![target.clone(), other.clone()]);
        assert!(LinuxCredentialBackend.read(&target).unwrap().is_none());
        LinuxCredentialBackend
            .write(&target, &[0, 255, 42, 0])
            .unwrap();
        LinuxCredentialBackend
            .write(&other, b"other-test-value")
            .unwrap();
        // Each operation creates a new service connection: no in-memory credential cache.
        assert_eq!(
            LinuxCredentialBackend.read(&target).unwrap().unwrap(),
            [0, 255, 42, 0]
        );
        LinuxCredentialBackend
            .write(&target, b"replacement")
            .unwrap();
        assert_eq!(
            LinuxCredentialBackend.read(&target).unwrap().unwrap(),
            b"replacement"
        );
        LinuxCredentialBackend.delete(&target).unwrap();
        LinuxCredentialBackend.delete(&target).unwrap();
        assert!(LinuxCredentialBackend.read(&target).unwrap().is_none());
        assert_eq!(
            LinuxCredentialBackend.read(&other).unwrap().unwrap(),
            b"other-test-value"
        );
    }
}
