use super::error::LibraryError;

const ALADIN_TARGET: &str = "Lakomics/AladinTTB";

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
}

impl<'a, B: CredentialBackend> CredentialService<'a, B> {
    fn new(backend: &'a B) -> Self {
        Self { backend }
    }

    fn configured(&self) -> Result<bool, LibraryError> {
        self.backend
            .read(ALADIN_TARGET)
            .map(|value| value.is_some())
            .map_err(map_backend_error)
    }

    fn set(&self, value: &str) -> Result<(), LibraryError> {
        let value = value.trim();
        if value.is_empty() {
            return Err(LibraryError::InvalidAladinCredentialValue);
        }

        self.backend
            .write(ALADIN_TARGET, value.as_bytes())
            .map_err(map_backend_error)
    }

    fn read(&self) -> Result<String, LibraryError> {
        let value = self
            .backend
            .read(ALADIN_TARGET)
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
        self.backend
            .delete(ALADIN_TARGET)
            .map_err(map_backend_error)
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
    CredentialService::new(&windows::WindowsCredentialBackend).configured()
}

#[cfg(target_os = "windows")]
pub(crate) fn set_aladin_key(value: &str) -> Result<(), LibraryError> {
    CredentialService::new(&windows::WindowsCredentialBackend).set(value)
}

#[cfg(target_os = "windows")]
pub(crate) fn delete_aladin_key() -> Result<(), LibraryError> {
    CredentialService::new(&windows::WindowsCredentialBackend).delete()
}

#[cfg(target_os = "windows")]
pub(crate) fn read_aladin_key() -> Result<String, LibraryError> {
    CredentialService::new(&windows::WindowsCredentialBackend).read()
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

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::{CredentialBackend, CredentialError, CredentialService};
    use crate::library::error::LibraryError;

    #[derive(Default)]
    struct FakeBackend {
        value: RefCell<Option<Vec<u8>>>,
        fail: bool,
    }

    impl CredentialBackend for FakeBackend {
        fn read(&self, _target: &str) -> Result<Option<Vec<u8>>, CredentialError> {
            if self.fail {
                Err(CredentialError::System(5))
            } else {
                Ok(self.value.borrow().clone())
            }
        }

        fn write(&self, _target: &str, value: &[u8]) -> Result<(), CredentialError> {
            if self.fail {
                Err(CredentialError::System(5))
            } else {
                *self.value.borrow_mut() = Some(value.to_vec());
                Ok(())
            }
        }

        fn delete(&self, _target: &str) -> Result<(), CredentialError> {
            if self.fail {
                Err(CredentialError::System(5))
            } else {
                *self.value.borrow_mut() = None;
                Ok(())
            }
        }
    }

    #[test]
    fn stores_replaces_and_deletes_a_trimmed_key_without_exposing_it_in_status() {
        let backend = FakeBackend::default();
        let service = CredentialService::new(&backend);

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
        let service = CredentialService::new(&backend);
        assert!(matches!(
            service.set("   "),
            Err(LibraryError::InvalidAladinCredentialValue)
        ));

        let failing = FakeBackend {
            value: RefCell::new(None),
            fail: true,
        };
        let error = CredentialService::new(&failing)
            .set("must-not-leak")
            .unwrap_err();
        assert!(matches!(error, LibraryError::CredentialStoreFailed));
        assert!(!error.to_string().contains("must-not-leak"));
    }
}
