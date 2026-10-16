//! Persistent P-256 identity. Only the public certificate is stored on disk.
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, PKCS_ECDSA_P256_SHA256};
use sha2::{Digest, Sha256};
use std::{fs, io, path::Path};
pub(in crate::exchange) trait KeyStore {
    fn read(&self) -> io::Result<Option<Vec<u8>>>;
    fn write(&self, key: &[u8]) -> io::Result<()>;
}
pub(in crate::exchange) struct OsKeyStore;
impl KeyStore for OsKeyStore {
    fn read(&self) -> io::Result<Option<Vec<u8>>> {
        crate::library::credential::read_lan_identity_key().map_err(io::Error::other)
    }
    fn write(&self, key: &[u8]) -> io::Result<()> {
        crate::library::credential::set_lan_identity_key(key).map_err(io::Error::other)
    }
}
pub(in crate::exchange) struct Identity {
    pub fingerprint: String,
    pub certificate: rustls::pki_types::CertificateDer<'static>,
    pub key: rustls::pki_types::PrivateKeyDer<'static>,
}
pub(in crate::exchange) fn load(
    dir: &Path,
    device_id: &str,
    store: &impl KeyStore,
) -> io::Result<Identity> {
    let stored_key = store.read()?;
    let new_key = stored_key.is_none();
    let key = match stored_key {
        Some(bytes) => KeyPair::from_pkcs8_der_and_sign_algo(
            &rustls::pki_types::PrivatePkcs8KeyDer::from(bytes),
            &PKCS_ECDSA_P256_SHA256,
        )
        .map_err(io::Error::other)?,
        None => {
            let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(io::Error::other)?;
            store.write(&key.serialize_der())?;
            key
        }
    };
    let path = dir.join("lan-identity.der");
    // A missing credential means any old certificate belongs to a different key.
    let mut cert = match fs::read(&path) {
        Ok(cert) if !new_key => cert,
        Ok(_) => generate_cert(dir, &path, device_id, &key)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            generate_cert(dir, &path, device_id, &key)?
        }
        Err(error) => return Err(error),
    };
    // Repair corrupt/mismatched public files using the credential-store key.
    if rustls::sign::CertifiedKey::from_der(
        vec![rustls::pki_types::CertificateDer::from(cert.clone())],
        rustls::pki_types::PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
        &rustls::crypto::ring::default_provider(),
    )
    .is_err()
    {
        cert = generate_cert(dir, &path, device_id, &key)?;
    }
    Ok(Identity {
        fingerprint: Sha256::digest(&cert)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        certificate: cert.into(),
        key: rustls::pki_types::PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
    })
}
fn generate_cert(dir: &Path, path: &Path, device_id: &str, key: &KeyPair) -> io::Result<Vec<u8>> {
    let mut params = CertificateParams::default();
    params.distinguished_name = DistinguishedName::new();
    params
        .distinguished_name
        .push(DnType::CommonName, format!("Lakomics {device_id}"));
    params.not_before = rcgen::date_time_ymd(2020, 1, 1);
    params.not_after = rcgen::date_time_ymd(2100, 1, 1);
    let cert = params
        .self_signed(key)
        .map_err(io::Error::other)?
        .der()
        .to_vec();
    fs::create_dir_all(dir)?;
    let mut temp = tempfile::NamedTempFile::new_in(dir)?;
    use std::io::Write;
    temp.write_all(&cert)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|error| error.error)?;
    Ok(cert)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct MemoryStore(std::cell::RefCell<Option<Vec<u8>>>);
    impl KeyStore for MemoryStore {
        fn read(&self) -> io::Result<Option<Vec<u8>>> {
            Ok(self.0.borrow().clone())
        }
        fn write(&self, key: &[u8]) -> io::Result<()> {
            *self.0.borrow_mut() = Some(key.to_vec());
            Ok(())
        }
    }
    #[test]
    fn reload_keeps_fingerprint_and_missing_cert_keeps_key_off_disk() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let first = load(dir.path(), "pc", &store).unwrap();
        assert_eq!(first.fingerprint.len(), 64);
        assert_eq!(
            first.fingerprint,
            load(dir.path(), "pc", &store).unwrap().fingerprint
        );
        let key = store.read().unwrap().unwrap();
        fs::remove_file(dir.path().join("lan-identity.der")).unwrap();
        let regenerated = load(dir.path(), "pc", &store).unwrap();
        assert_eq!(
            regenerated.fingerprint,
            load(dir.path(), "pc", &store).unwrap().fingerprint
        );
        assert_eq!(store.read().unwrap().unwrap(), key);
        assert!(dir.path().join("lan-identity.der").exists());
        let config = super::super::super::Stored::default();
        config.save(&dir.path().join("file-exchange.json")).unwrap();
        let pem = KeyPair::from_pkcs8_der_and_sign_algo(
            &rustls::pki_types::PrivatePkcs8KeyDer::from(key.clone()),
            &PKCS_ECDSA_P256_SHA256,
        )
        .unwrap()
        .serialize_pem();
        for entry in fs::read_dir(dir.path()).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            assert!(!bytes.windows(key.len()).any(|window| window == key));
            assert!(!String::from_utf8_lossy(&bytes).contains(&pem));
        }
    }
    #[test]
    fn corrupt_and_mismatched_certificates_are_repaired_from_stored_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let initial = load(dir.path(), "pc", &store).unwrap();
        let key = store.read().unwrap().unwrap();
        fs::write(dir.path().join("lan-identity.der"), b"corrupt").unwrap();
        let repaired = load(dir.path(), "pc", &store).unwrap();
        assert_ne!(initial.fingerprint, repaired.fingerprint);
        assert_eq!(key, store.read().unwrap().unwrap());
        let other = super::super::tls::test_identity();
        fs::write(
            dir.path().join("lan-identity.der"),
            other.certificate.as_ref(),
        )
        .unwrap();
        let repaired = load(dir.path(), "pc", &store).unwrap();
        assert_ne!(other.fingerprint, repaired.fingerprint);
        assert_eq!(key, store.read().unwrap().unwrap());
        rustls::sign::CertifiedKey::from_der(
            vec![repaired.certificate],
            repaired.key,
            &rustls::crypto::ring::default_provider(),
        )
        .unwrap();
    }
    #[test]
    fn unavailable_key_store_does_not_create_files() {
        struct Locked;
        impl KeyStore for Locked {
            fn read(&self) -> io::Result<Option<Vec<u8>>> {
                Err(io::Error::other("locked"))
            }
            fn write(&self, _: &[u8]) -> io::Result<()> {
                panic!("must not replace unavailable key")
            }
        }
        let dir = tempfile::tempdir().unwrap();
        assert!(load(dir.path(), "pc", &Locked).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
