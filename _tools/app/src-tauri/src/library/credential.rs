use super::error::LibraryError;
use super::models::{IgdbCredentialStatus, IgdbCredentials, TmdbCredentialStatus, TmdbCredentials};
use serde_json;
use std::fmt;
use zeroize::Zeroize;

#[cfg(windows)]
pub(crate) use windows::WindowsCredentialBackend as OsCredentialBackend;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub(crate) use linux::LinuxCredentialBackend as OsCredentialBackend;

const KAKAO_TARGET: &str = "Lakomics/KakaoBooks";
const ALADIN_TARGET: &str = "Lakomics/AladinTTB";
const CLOUD_API_TARGET: &str = "Lakomics/CloudApi";
/// Catalog publication/authority-management credential. Deliberately separate
/// from the general cloud token: publication is a `publisher` operation on the
/// server, while ordinary capture/sync/thumbnail APIs stay client-scoped. Holding
/// one must not imply the other.
const CLOUD_PUBLISHER_TARGET: &str = "Lakomics/CloudPublisher";
const IGDB_TARGET: &str = "Lakomics/Igdb";
const TMDB_TARGET: &str = "Lakomics/Tmdb";

/// Which cloud secret a worker needs.
///
/// The two are separate credentials on purpose - holding the ordinary client token must
/// never authorize a publisher operation - so they are cached and invalidated
/// independently by the process-session broker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum CredentialTarget {
    CloudApi,
    CloudPublisher,
}

impl CredentialTarget {
    /// The OS credential-store key this target reads and writes.
    pub(crate) fn store_key(self) -> &'static str {
        match self {
            Self::CloudApi => CLOUD_API_TARGET,
            Self::CloudPublisher => CLOUD_PUBLISHER_TARGET,
        }
    }
}

/// A cloud bearer token held for the lifetime of the process session.
///
/// Deliberately not `Clone` and not readable through `Debug`: obtaining the bytes is an
/// explicit [`CloudCredential::expose`] call, so every place a token reaches a network
/// call names itself, and duplicating one is a deliberate
/// [`CloudCredential::duplicate`] rather than an accidental `Clone` in passing. The
/// buffer is zeroed when the value is dropped or replaced.
pub(crate) struct CloudCredential(String);

impl CloudCredential {
    fn new(value: String) -> Self {
        Self(value)
    }

    /// The token bytes. Named `expose` so call sites are auditable: it should only ever be
    /// handed to an `Authorization` header, never logged or persisted.
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }

    /// Copy the secret. Only the process-session broker should need this, and only so it
    /// can hand a value to a caller without holding its cache lock across network I/O.
    pub(crate) fn duplicate(&self) -> Self {
        Self(self.0.clone())
    }
}

impl fmt::Debug for CloudCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never the value, its length, or any prefix/suffix of it.
        formatter.write_str("CloudCredential(<redacted>)")
    }
}

impl Drop for CloudCredential {
    fn drop(&mut self) {
        // Best-effort: a copy taken elsewhere can outlive this value, so this narrows
        // rather than closes the window in which the token sits in freed memory.
        self.0.zeroize();
    }
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn notes_key(target: &str) -> Result<Option<Vec<u8>>, LibraryError> {
    OsCredentialBackend.read(target).map_err(map_backend_error)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn set_notes_key(target: &str, value: &[u8]) -> Result<(), LibraryError> {
    OsCredentialBackend.write(target, value).map_err(map_backend_error)
}

#[cfg(all(test, any(windows, target_os = "linux")))]
pub(crate) fn delete_notes_test_key(target: &str) {
    OsCredentialBackend.delete(target).expect("remove isolated Notes test key");
}

/// OS credential-store target of an encrypted Private Vault master key (ADR-0039).
fn vault_key_target(vault_id: &str) -> String {
    format!("Lakomics/PrivateVault/{vault_id}")
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn vault_key(vault_id: &str) -> Result<Option<Vec<u8>>, LibraryError> {
    OsCredentialBackend
        .read(&vault_key_target(vault_id))
        .map_err(map_backend_error)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn set_vault_key(vault_id: &str, value: &[u8]) -> Result<(), LibraryError> {
    OsCredentialBackend
        .write(&vault_key_target(vault_id), value)
        .map_err(map_backend_error)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn delete_vault_key(vault_id: &str) -> Result<(), LibraryError> {
    OsCredentialBackend
        .delete(&vault_key_target(vault_id))
        .map_err(map_backend_error)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn vault_key(_vault_id: &str) -> Result<Option<Vec<u8>>, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn set_vault_key(_vault_id: &str, _value: &[u8]) -> Result<(), LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn delete_vault_key(_vault_id: &str) -> Result<(), LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[derive(Debug)]
pub(crate) enum CredentialError {
    System(u32),
    /// The store exists but cannot serve this request (for example a session-only
    /// collection). Kept unconditional rather than Linux-only so the backend contract,
    /// and the broker built on it, are identical on every platform.
    Unavailable,
    /// The store is present but locked. On Linux this is the Secret Service collection
    /// being locked, which a background reader must never try to unlock.
    Locked,
}

pub(crate) trait CredentialBackend {
    fn read(&self, target: &str) -> Result<Option<Vec<u8>>, CredentialError>;
    fn write(&self, target: &str, value: &[u8]) -> Result<(), CredentialError>;
    fn delete(&self, target: &str) -> Result<(), CredentialError>;
}

struct CredentialService<'a, B> {
    backend: &'a B,
    target: &'static str,
}

impl<'a, B: CredentialBackend> CredentialService<'a, B> {
    fn new(backend: &'a B, target: &'static str) -> Self {
        Self { backend, target }
    }

    fn configured(&self) -> Result<bool, LibraryError> {
        self.backend
            .read(self.target)
            .map(|value| value.is_some())
            .map_err(map_backend_error)
    }

    fn set(&self, value: &str) -> Result<(), LibraryError> {
        let value = value.trim();
        if value.is_empty() {
            return Err(LibraryError::InvalidAladinCredentialValue);
        }

        self.backend
            .write(self.target, value.as_bytes())
            .map_err(map_backend_error)
    }

    fn read(&self) -> Result<String, LibraryError> {
        let value = self
            .backend
            .read(self.target)
            .map_err(map_backend_error)?
            .ok_or(LibraryError::AladinCredentialNotConfigured)?;
        let value =
            String::from_utf8(value).map_err(|_| LibraryError::InvalidAladinCredentialValue)?;
        let value = value.trim();
        if value.is_empty() {
            return Err(LibraryError::InvalidAladinCredentialValue);
        }
        Ok(value.to_owned())
    }

    fn delete(&self) -> Result<(), LibraryError> {
        self.backend.delete(self.target).map_err(map_backend_error)
    }
}

fn map_backend_error(error: CredentialError) -> LibraryError {
    match error {
        CredentialError::System(_code) => LibraryError::CredentialStoreFailed,
        CredentialError::Unavailable => LibraryError::CredentialStoreUnavailable,
        CredentialError::Locked => LibraryError::CredentialStoreLocked,
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::{ptr, slice};

    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_NOT_FOUND},
        Security::Credentials::{
            CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
            CRED_TYPE_GENERIC,
        },
    };

    use super::{CredentialBackend, CredentialError};

    pub(crate) struct WindowsCredentialBackend;

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    impl CredentialBackend for WindowsCredentialBackend {
        fn read(&self, target: &str) -> Result<Option<Vec<u8>>, CredentialError> {
            let target = wide(target);
            let mut credential = ptr::null_mut();
            if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
                let code = unsafe { GetLastError() };
                return if code == ERROR_NOT_FOUND {
                    Ok(None)
                } else {
                    Err(CredentialError::System(code))
                };
            }

            let value = unsafe {
                let credential_ref = &*credential;
                let value = slice::from_raw_parts(
                    credential_ref.CredentialBlob,
                    credential_ref.CredentialBlobSize as usize,
                )
                .to_vec();
                CredFree(credential.cast());
                value
            };
            Ok(Some(value))
        }

        fn write(&self, target: &str, value: &[u8]) -> Result<(), CredentialError> {
            let mut target = wide(target);
            let mut username = wide("Lakomics");
            let mut value = value.to_vec();
            let credential = CREDENTIALW {
                Type: CRED_TYPE_GENERIC,
                TargetName: target.as_mut_ptr(),
                CredentialBlobSize: value.len() as u32,
                CredentialBlob: value.as_mut_ptr(),
                Persist: CRED_PERSIST_LOCAL_MACHINE,
                UserName: username.as_mut_ptr(),
                ..Default::default()
            };

            if unsafe { CredWriteW(&credential, 0) } == 0 {
                Err(CredentialError::System(unsafe { GetLastError() }))
            } else {
                Ok(())
            }
        }

        fn delete(&self, target: &str) -> Result<(), CredentialError> {
            let target = wide(target);
            if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
                let code = unsafe { GetLastError() };
                if code != ERROR_NOT_FOUND {
                    return Err(CredentialError::System(code));
                }
            }
            Ok(())
        }
    }
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn aladin_key_status() -> Result<bool, LibraryError> {
    CredentialService::new(&OsCredentialBackend, ALADIN_TARGET).configured()
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn set_aladin_key(value: &str) -> Result<(), LibraryError> {
    CredentialService::new(&OsCredentialBackend, ALADIN_TARGET).set(value)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn delete_aladin_key() -> Result<(), LibraryError> {
    CredentialService::new(&OsCredentialBackend, ALADIN_TARGET).delete()
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn read_aladin_key() -> Result<String, LibraryError> {
    CredentialService::new(&OsCredentialBackend, ALADIN_TARGET).read()
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn cloud_api_token_status() -> Result<bool, LibraryError> {
    cloud_api_token_status_with(&OsCredentialBackend)
}

/// Replace the stored Cloud API credential and drop any cached value for it.
///
/// Invalidation is unconditional and happens whether or not the write succeeded, because
/// the only safe assumption after a credential mutation is that the process no longer
/// knows what the store holds.
#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn set_cloud_api_token_os(token: &str) -> Result<(), LibraryError> {
    let result = set_cloud_api_token(&OsCredentialBackend, token);
    super::credential_broker::broker().invalidate(CredentialTarget::CloudApi);
    result
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn delete_cloud_api_token_os() -> Result<(), LibraryError> {
    let result = OsCredentialBackend
        .delete(CLOUD_API_TARGET)
        .map_err(map_backend_error);
    super::credential_broker::broker().invalidate(CredentialTarget::CloudApi);
    result
}

/// The Cloud API credential from the process session, loading it from the OS store on
/// first use.
///
/// This is the accessor every cloud worker uses. Reading through the process-session
/// broker is what keeps a transient keyring lock from stopping capture polling, metadata
/// publication and replication once the process already holds a valid credential.
#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn read_cloud_api_token_os() -> Result<CloudCredential, LibraryError> {
    super::credential_broker::broker().credential(CredentialTarget::CloudApi)
}

/// Read the Cloud API credential directly from the OS store, bypassing the session cache.
///
/// The broker's own loader, and nothing else's: a caller that wants a fresh value must
/// invalidate the cache and go through [`read_cloud_api_token_os`].
#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn read_cloud_api_token_from_store() -> Result<CloudCredential, LibraryError> {
    Ok(CloudCredential::new(read_cloud_api_token(&OsCredentialBackend)?))
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn cloud_publisher_token_status() -> Result<bool, LibraryError> {
    cloud_publisher_token_status_with(&OsCredentialBackend)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn set_cloud_publisher_token_os(token: &str) -> Result<(), LibraryError> {
    let result = set_cloud_publisher_token(&OsCredentialBackend, token);
    super::credential_broker::broker().invalidate(CredentialTarget::CloudPublisher);
    result
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn delete_cloud_publisher_token_os() -> Result<(), LibraryError> {
    let result = OsCredentialBackend
        .delete(CLOUD_PUBLISHER_TARGET)
        .map_err(map_backend_error);
    super::credential_broker::broker().invalidate(CredentialTarget::CloudPublisher);
    result
}

/// The publisher credential from the process session; see [`read_cloud_api_token_os`].
#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn read_cloud_publisher_token_os() -> Result<CloudCredential, LibraryError> {
    super::credential_broker::broker().credential(CredentialTarget::CloudPublisher)
}

/// Read the publisher credential directly from the OS store; see
/// [`read_cloud_api_token_from_store`].
#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn read_cloud_publisher_token_from_store() -> Result<CloudCredential, LibraryError> {
    Ok(CloudCredential::new(read_cloud_publisher_token(&OsCredentialBackend)?))
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn aladin_key_status() -> Result<bool, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn set_aladin_key(_value: &str) -> Result<(), LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn delete_aladin_key() -> Result<(), LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn read_aladin_key() -> Result<String, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn cloud_api_token_status() -> Result<bool, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn set_cloud_api_token_os(_token: &str) -> Result<(), LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn delete_cloud_api_token_os() -> Result<(), LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn read_cloud_api_token_os() -> Result<CloudCredential, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn read_cloud_api_token_from_store() -> Result<CloudCredential, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn cloud_publisher_token_status() -> Result<bool, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn set_cloud_publisher_token_os(_token: &str) -> Result<(), LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn delete_cloud_publisher_token_os() -> Result<(), LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn read_cloud_publisher_token_os() -> Result<CloudCredential, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn read_cloud_publisher_token_from_store() -> Result<CloudCredential, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn igdb_credential_status() -> Result<IgdbCredentialStatus, LibraryError> {
    igdb_credentials_status(&OsCredentialBackend)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn set_igdb_credentials_os(
    client_id: &str,
    client_secret: &str,
) -> Result<IgdbCredentialStatus, LibraryError> {
    set_igdb_credentials(&OsCredentialBackend, client_id, client_secret)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn delete_igdb_credentials_os() -> Result<IgdbCredentialStatus, LibraryError> {
    delete_igdb_credentials(&OsCredentialBackend)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn read_igdb_credentials_os() -> Result<IgdbCredentials, LibraryError> {
    read_igdb_credentials(&OsCredentialBackend)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn tmdb_credential_status() -> Result<TmdbCredentialStatus, LibraryError> {
    tmdb_token_status(&OsCredentialBackend)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn set_tmdb_token_os(token: &str) -> Result<TmdbCredentialStatus, LibraryError> {
    set_tmdb_token(&OsCredentialBackend, token)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn delete_tmdb_token_os() -> Result<TmdbCredentialStatus, LibraryError> {
    delete_tmdb_token(&OsCredentialBackend)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn read_tmdb_token_os() -> Result<TmdbCredentials, LibraryError> {
    read_tmdb_token(&OsCredentialBackend)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn igdb_credential_status() -> Result<IgdbCredentialStatus, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn set_igdb_credentials_os(
    _client_id: &str,
    _client_secret: &str,
) -> Result<IgdbCredentialStatus, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn delete_igdb_credentials_os() -> Result<IgdbCredentialStatus, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn read_igdb_credentials_os() -> Result<IgdbCredentials, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn tmdb_credential_status() -> Result<TmdbCredentialStatus, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn set_tmdb_token_os(_token: &str) -> Result<TmdbCredentialStatus, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn delete_tmdb_token_os() -> Result<TmdbCredentialStatus, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn read_tmdb_token_os() -> Result<TmdbCredentials, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::HashMap};

    use super::{
        read_cloud_api_token, read_cloud_publisher_token, read_igdb_credentials_with,
        read_tmdb_token_with, set_cloud_api_token, set_cloud_publisher_token,
        set_igdb_credentials_with, set_tmdb_token_with, cloud_publisher_token_status_with,
        CredentialBackend, CredentialError, CredentialService, ALADIN_TARGET, CLOUD_API_TARGET,
        CLOUD_PUBLISHER_TARGET, TMDB_TARGET,
    };
    use crate::library::error::LibraryError;

    #[derive(Default)]
    struct FakeBackend {
        values: RefCell<HashMap<String, Vec<u8>>>,
        fail: bool,
    }

    impl CredentialBackend for FakeBackend {
        fn read(&self, target: &str) -> Result<Option<Vec<u8>>, CredentialError> {
            if self.fail {
                Err(CredentialError::System(5))
            } else {
                Ok(self.values.borrow().get(target).cloned())
            }
        }

        fn write(&self, target: &str, value: &[u8]) -> Result<(), CredentialError> {
            if self.fail {
                Err(CredentialError::System(5))
            } else {
                self.values
                    .borrow_mut()
                    .insert(target.to_owned(), value.to_vec());
                Ok(())
            }
        }

        fn delete(&self, target: &str) -> Result<(), CredentialError> {
            if self.fail {
                Err(CredentialError::System(5))
            } else {
                self.values.borrow_mut().remove(target);
                Ok(())
            }
        }
    }

    #[test]
    fn stores_replaces_and_deletes_a_trimmed_key_without_exposing_it_in_status() {
        let backend = FakeBackend::default();
        let service = CredentialService::new(&backend, ALADIN_TARGET);

        assert!(!service.configured().unwrap());
        service.set("  first-secret  ").unwrap();
        assert!(service.configured().unwrap());
        assert_eq!(service.read().unwrap(), "first-secret");
        service.set("second-secret").unwrap();
        assert_eq!(service.read().unwrap(), "second-secret");
        service.delete().unwrap();
        assert!(!service.configured().unwrap());
        assert!(matches!(
            service.read(),
            Err(LibraryError::AladinCredentialNotConfigured)
        ));
    }

    #[test]
    fn rejects_empty_keys_and_redacts_backend_failures() {
        let backend = FakeBackend::default();
        let service = CredentialService::new(&backend, ALADIN_TARGET);
        assert!(matches!(
            service.set("   "),
            Err(LibraryError::InvalidAladinCredentialValue)
        ));

        let failing = FakeBackend {
            values: RefCell::new(HashMap::new()),
            fail: true,
        };
        let error = CredentialService::new(&failing, ALADIN_TARGET)
            .set("must-not-leak")
            .unwrap_err();
        assert!(matches!(error, LibraryError::CredentialStoreFailed));
        assert!(!error.to_string().contains("must-not-leak"));
    }

    #[test]
    fn stores_igdb_credentials_without_exposing_values() {
        let backend = FakeBackend::default();
        let stored = set_igdb_credentials_with(&backend, "client-id", "client-secret").unwrap();

        assert!(stored.configured);
        assert_eq!(
            read_igdb_credentials_with(&backend).unwrap().client_id,
            "client-id"
        );
        assert!(!format!("{:?}", stored).contains("client-secret"));
    }

    #[test]
    fn isolates_igdb_target_and_deletes_only_igdb_credentials() {
        let backend = FakeBackend::default();
        let aladin = CredentialService::new(&backend, ALADIN_TARGET);
        aladin.set("aladin-secret").unwrap();
        set_igdb_credentials_with(&backend, "client-id", "client-secret").unwrap();
        assert_eq!(aladin.read().unwrap(), "aladin-secret");
        super::delete_igdb_credentials(&backend).unwrap();
        assert_eq!(aladin.read().unwrap(), "aladin-secret");
        assert!(matches!(
            read_igdb_credentials_with(&backend),
            Err(LibraryError::IgdbCredentialNotConfigured)
        ));
    }

    #[test]
    fn stores_and_reads_a_trimmed_tmdb_token_without_exposing_it() {
        let backend = FakeBackend::default();

        assert!(
            set_tmdb_token_with(&backend, "  secret-token  ")
                .unwrap()
                .configured
        );
        let credentials = read_tmdb_token_with(&backend).unwrap();
        assert_eq!(credentials.read_access_token, "secret-token");
        assert!(!format!("{credentials:?}").contains("secret-token"));
        assert_eq!(
            backend.values.borrow().get(TMDB_TARGET).unwrap(),
            b"secret-token"
        );
    }

    #[test]
    fn rejects_empty_tmdb_tokens_and_missing_or_corrupt_values() {
        let backend = FakeBackend::default();
        assert!(matches!(
            set_tmdb_token_with(&backend, "   "),
            Err(LibraryError::InvalidTmdbCredentialValue)
        ));
        assert!(matches!(
            read_tmdb_token_with(&backend),
            Err(LibraryError::TmdbCredentialNotConfigured)
        ));

        backend
            .values
            .borrow_mut()
            .insert(TMDB_TARGET.to_owned(), vec![0xff]);
        assert!(matches!(
            read_tmdb_token_with(&backend),
            Err(LibraryError::InvalidTmdbCredentialValue)
        ));
    }

    #[test]
    fn publisher_token_is_a_separate_credential_from_the_cloud_token() {
        let backend = FakeBackend::default();

        set_cloud_api_token(&backend, "client-credential").unwrap();
        set_cloud_publisher_token(&backend, "publisher-credential").unwrap();
        // Each is readable under its own target and neither overwrites the other:
        // publication must not be authorized by the general client credential.
        assert_eq!(
            read_cloud_api_token(&backend).unwrap(),
            "client-credential"
        );
        assert_eq!(
            read_cloud_publisher_token(&backend).unwrap(),
            "publisher-credential"
        );
        assert_eq!(
            backend.values.borrow().get(CLOUD_PUBLISHER_TARGET).unwrap(),
            b"publisher-credential"
        );
        assert!(cloud_publisher_token_status_with(&backend).unwrap());
    }

    #[test]
    fn an_absent_publisher_token_is_reported_rather_than_borrowed() {
        let backend = FakeBackend::default();
        set_cloud_api_token(&backend, "client-credential").unwrap();
        // A configured client credential must not make publication look configured.
        assert!(!cloud_publisher_token_status_with(&backend).unwrap());
        assert!(matches!(
            read_cloud_publisher_token(&backend),
            Err(LibraryError::CloudCredentialNotConfigured)
        ));
    }

    #[test]
    fn publisher_token_rejects_empty_values() {
        let backend = FakeBackend::default();
        assert!(matches!(
            set_cloud_publisher_token(&backend, "   "),
            Err(LibraryError::InvalidCloudCredentialValue)
        ));
    }

    #[test]
    fn stores_cloud_token_in_its_own_credential_target() {
        let backend = FakeBackend::default();

        set_cloud_api_token(&backend, "  cloud-secret  ").unwrap();
        assert_eq!(read_cloud_api_token(&backend).unwrap(), "cloud-secret");
        assert_eq!(
            backend.values.borrow().get(CLOUD_API_TARGET).unwrap(),
            b"cloud-secret"
        );
        assert!(matches!(
            set_cloud_api_token(&backend, "  "),
            Err(LibraryError::InvalidCloudCredentialValue)
        ));
    }
}

fn validate_cloud_api_token(token: &str) -> Result<String, LibraryError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(LibraryError::InvalidCloudCredentialValue);
    }
    Ok(token.to_owned())
}

fn set_secret<B: CredentialBackend>(
    backend: &B,
    target: &str,
    token: &str,
) -> Result<(), LibraryError> {
    let token = validate_cloud_api_token(token)?;
    backend.write(target, token.as_bytes()).map_err(map_backend_error)
}

fn read_secret<B: CredentialBackend>(
    backend: &B,
    target: &str,
) -> Result<String, LibraryError> {
    let value = backend
        .read(target)
        .map_err(map_backend_error)?
        .ok_or(LibraryError::CloudCredentialNotConfigured)?;
    let token = String::from_utf8(value).map_err(|_| LibraryError::InvalidCloudCredentialValue)?;
    validate_cloud_api_token(&token)
}

/// Read one cloud credential from any backend, by target.
///
/// The broker's single load path: it is backend-generic so the production store and a
/// test double go through exactly the same validation, error mapping and
/// `CloudCredential` construction.
pub(crate) fn read_secret_for<B: CredentialBackend>(
    backend: &B,
    target: CredentialTarget,
) -> Result<CloudCredential, LibraryError> {
    Ok(CloudCredential::new(read_secret(backend, target.store_key())?))
}

fn secret_status<B: CredentialBackend>(
    backend: &B,
    target: &str,
) -> Result<bool, LibraryError> {
    backend
        .read(target)
        .map(|value| value.is_some())
        .map_err(map_backend_error)
}

fn set_cloud_api_token<B: CredentialBackend>(backend: &B, token: &str) -> Result<(), LibraryError> {
    set_secret(backend, CLOUD_API_TARGET, token)
}

fn read_cloud_api_token<B: CredentialBackend>(backend: &B) -> Result<String, LibraryError> {
    read_secret(backend, CLOUD_API_TARGET)
}

fn cloud_api_token_status_with<B: CredentialBackend>(backend: &B) -> Result<bool, LibraryError> {
    secret_status(backend, CLOUD_API_TARGET)
}

fn set_cloud_publisher_token<B: CredentialBackend>(
    backend: &B,
    token: &str,
) -> Result<(), LibraryError> {
    set_secret(backend, CLOUD_PUBLISHER_TARGET, token)
}

fn read_cloud_publisher_token<B: CredentialBackend>(backend: &B) -> Result<String, LibraryError> {
    read_secret(backend, CLOUD_PUBLISHER_TARGET)
}

fn cloud_publisher_token_status_with<B: CredentialBackend>(
    backend: &B,
) -> Result<bool, LibraryError> {
    secret_status(backend, CLOUD_PUBLISHER_TARGET)
}

fn validate_igdb_credentials(
    client_id: &str,
    client_secret: &str,
) -> Result<IgdbCredentials, LibraryError> {
    let client_id = client_id.trim();
    let client_secret = client_secret.trim();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err(LibraryError::InvalidIgdbCredentialValue);
    }
    Ok(IgdbCredentials {
        client_id: client_id.to_owned(),
        client_secret: client_secret.to_owned(),
    })
}

fn set_igdb_credentials<B: CredentialBackend>(
    backend: &B,
    client_id: &str,
    client_secret: &str,
) -> Result<IgdbCredentialStatus, LibraryError> {
    let credentials = validate_igdb_credentials(client_id, client_secret)?;
    let value =
        serde_json::to_vec(&credentials).map_err(|_| LibraryError::InvalidIgdbCredentialValue)?;
    backend
        .write(IGDB_TARGET, &value)
        .map_err(map_backend_error)?;
    Ok(IgdbCredentialStatus { configured: true })
}

fn read_igdb_credentials<B: CredentialBackend>(
    backend: &B,
) -> Result<IgdbCredentials, LibraryError> {
    let value = backend
        .read(IGDB_TARGET)
        .map_err(map_backend_error)?
        .ok_or(LibraryError::IgdbCredentialNotConfigured)?;
    let credentials: IgdbCredentials =
        serde_json::from_slice(&value).map_err(|_| LibraryError::InvalidIgdbCredential)?;
    validate_igdb_credentials(&credentials.client_id, &credentials.client_secret)
        .map_err(|_| LibraryError::InvalidIgdbCredential)
}

fn igdb_credentials_status<B: CredentialBackend>(
    backend: &B,
) -> Result<IgdbCredentialStatus, LibraryError> {
    Ok(IgdbCredentialStatus {
        configured: backend
            .read(IGDB_TARGET)
            .map_err(map_backend_error)?
            .is_some(),
    })
}

fn delete_igdb_credentials<B: CredentialBackend>(
    backend: &B,
) -> Result<IgdbCredentialStatus, LibraryError> {
    backend.delete(IGDB_TARGET).map_err(map_backend_error)?;
    Ok(IgdbCredentialStatus { configured: false })
}

fn validate_tmdb_token(token: &str) -> Result<TmdbCredentials, LibraryError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(LibraryError::InvalidTmdbCredentialValue);
    }
    Ok(TmdbCredentials {
        read_access_token: token.to_owned(),
    })
}

fn set_tmdb_token<B: CredentialBackend>(
    backend: &B,
    token: &str,
) -> Result<TmdbCredentialStatus, LibraryError> {
    let token = validate_tmdb_token(token)?;
    backend
        .write(TMDB_TARGET, token.read_access_token.as_bytes())
        .map_err(map_backend_error)?;
    Ok(TmdbCredentialStatus { configured: true })
}

fn read_tmdb_token<B: CredentialBackend>(backend: &B) -> Result<TmdbCredentials, LibraryError> {
    let value = backend
        .read(TMDB_TARGET)
        .map_err(map_backend_error)?
        .ok_or(LibraryError::TmdbCredentialNotConfigured)?;
    let token = String::from_utf8(value).map_err(|_| LibraryError::InvalidTmdbCredentialValue)?;
    validate_tmdb_token(&token)
}

fn tmdb_token_status<B: CredentialBackend>(
    backend: &B,
) -> Result<TmdbCredentialStatus, LibraryError> {
    Ok(TmdbCredentialStatus {
        configured: backend
            .read(TMDB_TARGET)
            .map_err(map_backend_error)?
            .is_some(),
    })
}

fn delete_tmdb_token<B: CredentialBackend>(
    backend: &B,
) -> Result<TmdbCredentialStatus, LibraryError> {
    backend.delete(TMDB_TARGET).map_err(map_backend_error)?;
    Ok(TmdbCredentialStatus { configured: false })
}

#[cfg(test)]
fn set_igdb_credentials_with<B: CredentialBackend>(
    backend: &B,
    client_id: &str,
    client_secret: &str,
) -> Result<IgdbCredentialStatus, LibraryError> {
    set_igdb_credentials(backend, client_id, client_secret)
}

#[cfg(test)]
fn read_igdb_credentials_with<B: CredentialBackend>(
    backend: &B,
) -> Result<IgdbCredentials, LibraryError> {
    read_igdb_credentials(backend)
}

#[cfg(test)]
fn set_tmdb_token_with<B: CredentialBackend>(
    backend: &B,
    token: &str,
) -> Result<TmdbCredentialStatus, LibraryError> {
    set_tmdb_token(backend, token)
}

#[cfg(test)]
fn read_tmdb_token_with<B: CredentialBackend>(
    backend: &B,
) -> Result<TmdbCredentials, LibraryError> {
    read_tmdb_token(backend)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn kakao_key_status() -> Result<bool, LibraryError> {
    CredentialService::new(&OsCredentialBackend, KAKAO_TARGET).configured()
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn set_kakao_key(value: &str) -> Result<(), LibraryError> {
    CredentialService::new(&OsCredentialBackend, KAKAO_TARGET).set(value)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn delete_kakao_key() -> Result<(), LibraryError> {
    CredentialService::new(&OsCredentialBackend, KAKAO_TARGET).delete()
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn read_kakao_key() -> Result<String, LibraryError> {
    CredentialService::new(&OsCredentialBackend, KAKAO_TARGET).read()
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn kakao_key_status() -> Result<bool, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn set_kakao_key(_value: &str) -> Result<(), LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn delete_kakao_key() -> Result<(), LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn read_kakao_key() -> Result<String, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn notes_key(_target: &str) -> Result<Option<Vec<u8>>, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn set_notes_key(_target: &str, _value: &[u8]) -> Result<(), LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

/// Test doubles for the process-session broker.
///
/// A counting backend rather than a mock: the broker's contract is *how many* store
/// reads happen and which errors propagate, so the double records reads per target and
/// can be locked or unlocked between them. It uses the production
/// [`CredentialBackend`] contract, so the code under test is the same code that runs
/// against the Secret Service.
#[cfg(test)]
pub(crate) mod test_support {
    use super::{CredentialBackend, CredentialError};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, PoisonError};

    #[derive(Default)]
    struct Store {
        values: HashMap<String, Vec<u8>>,
        reads: HashMap<String, u32>,
        locked: bool,
    }

    /// A shared, clonable credential backend that counts reads per target.
    ///
    /// `Clone` shares the same store, which is what lets a test keep a handle for
    /// assertions while the broker owns another.
    #[derive(Clone, Default)]
    pub(crate) struct CountingBackend {
        store: Arc<Mutex<Store>>,
    }

    impl CountingBackend {
        pub(crate) fn set(&self, target: &str, value: &str) {
            self.store
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .values
                .insert(target.to_owned(), value.as_bytes().to_vec());
        }

        pub(crate) fn delete(&self, target: &str) {
            self.store
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .values
                .remove(target);
        }

        /// Make every subsequent read fail as a locked store.
        pub(crate) fn lock(&self) {
            self.store
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .locked = true;
        }

        /// How many reads this target has served.
        pub(crate) fn read_count(&self, target: &str) -> u32 {
            self.store
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .reads
                .get(target)
                .copied()
                .unwrap_or(0)
        }
    }

    impl CredentialBackend for CountingBackend {
        fn read(&self, target: &str) -> Result<Option<Vec<u8>>, CredentialError> {
            let mut store = self.store.lock().unwrap_or_else(PoisonError::into_inner);
            *store.reads.entry(target.to_owned()).or_insert(0) += 1;
            if store.locked {
                return Err(CredentialError::Locked);
            }
            Ok(store.values.get(target).cloned())
        }

        fn write(&self, target: &str, value: &[u8]) -> Result<(), CredentialError> {
            let mut store = self.store.lock().unwrap_or_else(PoisonError::into_inner);
            if store.locked {
                return Err(CredentialError::Locked);
            }
            store.values.insert(target.to_owned(), value.to_vec());
            Ok(())
        }

        fn delete(&self, target: &str) -> Result<(), CredentialError> {
            let mut store = self.store.lock().unwrap_or_else(PoisonError::into_inner);
            if store.locked {
                return Err(CredentialError::Locked);
            }
            store.values.remove(target);
            Ok(())
        }
    }
}
