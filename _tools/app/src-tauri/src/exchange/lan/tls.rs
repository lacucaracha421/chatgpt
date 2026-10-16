//! Explicit ring-backed TLS 1.3 with certificate pins and handshake signatures.
use super::identity::Identity;
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    server::danger::{ClientCertVerified, ClientCertVerifier},
    DigitallySignedStruct, DistinguishedName, Error, SignatureScheme,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub(super) fn fingerprint(cert: &CertificateDer<'_>) -> String {
    Sha256::digest(cert.as_ref())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

type Pins = dyn Fn(&str) -> bool + Send + Sync;
pub(super) struct Pinned(Arc<Pins>);
impl std::fmt::Debug for Pinned {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Pinned")
    }
}
impl Pinned {
    pub(super) fn new(pins: impl Fn(&str) -> bool + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self(Arc::new(pins)))
    }
    fn check(&self, cert: &CertificateDer<'_>) -> Result<(), Error> {
        if (self.0)(&fingerprint(cert)) {
            Ok(())
        } else {
            Err(Error::InvalidCertificate(
                rustls::CertificateError::UnknownIssuer,
            ))
        }
    }
}
fn signature(
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, Error> {
    rustls::crypto::verify_tls13_signature(
        message,
        cert,
        dss,
        &rustls::crypto::ring::default_provider().signature_verification_algorithms,
    )
}
fn schemes() -> Vec<SignatureScheme> {
    rustls::crypto::ring::default_provider()
        .signature_verification_algorithms
        .supported_schemes()
}
impl ClientCertVerifier for Pinned {
    fn client_auth_mandatory(&self) -> bool {
        true
    }
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }
    fn verify_client_cert(
        &self,
        cert: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        self.check(cert)?;
        Ok(ClientCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(Error::General("TLS 1.3 required".into()))
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        signature(m, c, s)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        schemes()
    }
}
impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        self.check(cert)?;
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(Error::General("TLS 1.3 required".into()))
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        signature(m, c, s)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        schemes()
    }
}
pub(super) fn server(
    identity: &Identity,
    pins: Arc<Pinned>,
) -> Result<rustls::ServerConfig, Error> {
    rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_client_cert_verifier(pins)
        .with_single_cert(vec![identity.certificate.clone()], identity.key.clone_key())
        .map(|mut config| {
            config.send_tls13_tickets = 0;
            config
        })
}

#[cfg(test)]
pub(super) fn test_identity() -> Identity {
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    let certificate = rcgen::CertificateParams::default()
        .self_signed(&key)
        .unwrap()
        .der()
        .clone();
    Identity {
        fingerprint: fingerprint(&certificate),
        certificate,
        key: rustls::pki_types::PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        time::Duration,
    };
    fn loopback(known_client: bool, known_server: bool, client_cert: bool) -> (bool, bool) {
        let server_id = test_identity();
        let client_id = test_identity();
        let client_pin = if known_client {
            client_id.fingerprint.clone()
        } else {
            "0".repeat(64)
        };
        let server_pin = if known_server {
            server_id.fingerprint.clone()
        } else {
            "0".repeat(64)
        };
        let server_config =
            Arc::new(server(&server_id, Pinned::new(move |pin| pin == client_pin)).unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || -> std::io::Result<()> {
            let (mut socket, _) = listener.accept()?;
            socket.set_read_timeout(Some(Duration::from_secs(3)))?;
            socket.set_write_timeout(Some(Duration::from_secs(3)))?;
            let mut conn = rustls::ServerConnection::new(server_config).unwrap();
            let mut stream = rustls::Stream::new(&mut conn, &mut socket);
            let mut byte = [0];
            stream.read_exact(&mut byte)?;
            stream.write_all(&byte)?;
            stream.flush()?;
            assert_eq!(
                conn.protocol_version(),
                Some(rustls::ProtocolVersion::TLSv1_3)
            );
            Ok(())
        });
        let builder = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Pinned::new(move |pin| pin == server_pin));
        let config = if client_cert {
            builder
                .with_client_auth_cert(vec![client_id.certificate], client_id.key)
                .unwrap()
        } else {
            builder.with_no_client_auth()
        };
        let client = (|| -> std::io::Result<()> {
            let mut socket = TcpStream::connect(addr)?;
            socket.set_read_timeout(Some(Duration::from_secs(3)))?;
            socket.set_write_timeout(Some(Duration::from_secs(3)))?;
            let mut conn = rustls::ClientConnection::new(
                Arc::new(config),
                ServerName::try_from("ignored.invalid").unwrap(),
            )
            .unwrap();
            let mut stream = rustls::Stream::new(&mut conn, &mut socket);
            stream.write_all(b"x")?;
            stream.flush()?;
            let mut byte = [0];
            stream.read_exact(&mut byte)?;
            assert_eq!(&byte, b"x");
            Ok(())
        })();
        (client.is_ok(), worker.join().unwrap().is_ok())
    }
    #[test]
    fn pinned_mutual_tls13_loopback() {
        assert_eq!(loopback(true, true, true), (true, true));
    }
    #[test]
    fn unknown_client_certificate_fails() {
        assert_eq!(loopback(false, true, true), (false, false));
    }
    #[test]
    fn unknown_server_certificate_fails() {
        assert_eq!(loopback(true, false, true), (false, false));
    }
    #[test]
    fn missing_client_certificate_fails() {
        assert_eq!(loopback(true, true, false), (false, false));
    }
}
