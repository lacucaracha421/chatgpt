use super::error::LibraryError;
use super::models::{IgdbCredentialStatus, IgdbCredentials};
use serde_json;

const ALADIN_TARGET: &str = "Lakomics/AladinTTB";
const IGDB_TARGET: &str = "Lakomics/Igdb";

#[derive(Debug)]
enum CredentialError {
    System(u32),
}

trait CredentialBackend {
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
    let CredentialError::System(_code) = error;
    LibraryError::CredentialStoreFailed
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

    pub(super) struct WindowsCredentialBackend;

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

#[cfg(target_os = "windows")]
pub(crate) fn aladin_key_status() -> Result<bool, LibraryError> {
    CredentialService::new(&windows::WindowsCredentialBackend, ALADIN_TARGET).configured()
}

#[cfg(target_os = "windows")]
pub(crate) fn set_aladin_key(value: &str) -> Result<(), LibraryError> {
    CredentialService::new(&windows::WindowsCredentialBackend, ALADIN_TARGET).set(value)
}

#[cfg(target_os = "windows")]
pub(crate) fn delete_aladin_key() -> Result<(), LibraryError> {
    CredentialService::new(&windows::WindowsCredentialBackend, ALADIN_TARGET).delete()
}

#[cfg(target_os = "windows")]
pub(crate) fn read_aladin_key() -> Result<String, LibraryError> {
    CredentialService::new(&windows::WindowsCredentialBackend, ALADIN_TARGET).read()
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn aladin_key_status() -> Result<bool, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn set_aladin_key(_value: &str) -> Result<(), LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn delete_aladin_key() -> Result<(), LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn read_aladin_key() -> Result<String, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(target_os = "windows")]
pub(crate) fn igdb_credential_status() -> Result<IgdbCredentialStatus, LibraryError> {
    igdb_credentials_status(&windows::WindowsCredentialBackend)
}

#[cfg(target_os = "windows")]
pub(crate) fn set_igdb_credentials_os(
    client_id: &str,
    client_secret: &str,
) -> Result<IgdbCredentialStatus, LibraryError> {
    set_igdb_credentials(&windows::WindowsCredentialBackend, client_id, client_secret)
}

#[cfg(target_os = "windows")]
pub(crate) fn delete_igdb_credentials_os() -> Result<IgdbCredentialStatus, LibraryError> {
    delete_igdb_credentials(&windows::WindowsCredentialBackend)
}

#[cfg(target_os = "windows")]
pub(crate) fn read_igdb_credentials_os() -> Result<IgdbCredentials, LibraryError> {
    read_igdb_credentials(&windows::WindowsCredentialBackend)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn igdb_credential_status() -> Result<IgdbCredentialStatus, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn set_igdb_credentials_os(
    _client_id: &str,
    _client_secret: &str,
) -> Result<IgdbCredentialStatus, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn delete_igdb_credentials_os() -> Result<IgdbCredentialStatus, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn read_igdb_credentials_os() -> Result<IgdbCredentials, LibraryError> {
    Err(LibraryError::CredentialStoreUnavailable)
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::HashMap};

    use super::{
        read_igdb_credentials_with, set_igdb_credentials_with, CredentialBackend, CredentialError,
        CredentialService, ALADIN_TARGET,
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
